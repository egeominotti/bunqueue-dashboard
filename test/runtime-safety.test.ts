import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import type { BackupRunnerPort } from '../agent/backup/runner';
import { BunqueueBackupRunner } from '../agent/backup/runner';
import { assertManagedTarget, managedAuthToken } from '../agent/managedTarget';
import { ProcessManager, type ServerConfig, type StatusSnapshot } from '../agent/manager';
import type { QueueOperationsPort } from '../agent/queue/types';
import { createFetchHandler } from '../agent/server';
import { WorkflowRuntime, type WorkflowRuntimePort } from '../agent/workflow/runtime';

const paths: string[] = [];
const baseConfig: ServerConfig = {
  command: 'sleep 30',
  httpPort: 6790,
  tcpPort: 6789,
  dataPath: '/tmp/runtime-safety.db',
  extraEnv: {},
};

afterEach(() => {
  for (const path of paths.splice(0)) rmSync(path, { force: true });
});

describe('agent runtime safety contracts', () => {
  test('fails /api closed when its actual proxy is not the managed server', () => {
    const api = new URLSearchParams({ target: '/api' });
    expect(() => assertManagedTarget(api, baseConfig, 'http://127.0.0.1:7777')).toThrow(
      'does not match'
    );
    expect(() => assertManagedTarget(api, baseConfig, 'http://localhost:6790')).not.toThrow();
  });

  test('uses the inherited auth token but respects an explicit empty override', () => {
    const previous = process.env.AUTH_TOKENS;
    process.env.AUTH_TOKENS = ' first , second ';
    try {
      expect(managedAuthToken(baseConfig)).toBe('first');
      expect(managedAuthToken({ ...baseConfig, extraEnv: { AUTH_TOKENS: '' } })).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.AUTH_TOKENS;
      else process.env.AUTH_TOKENS = previous;
    }
  });

  test('cancels and awaits an active backup operation on idempotent close', async () => {
    let aborts = 0;
    const runner = new BunqueueBackupRunner(
      1_000,
      (_env, _operation, _key, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborts++;
            reject(signal.reason);
          });
        })
    );
    const result = runner.execute(baseConfig, 'status').catch((error) => error as Error);
    await Bun.sleep(0);
    await Promise.all([runner.close(), runner.close()]);
    expect((await result).message).toContain('control agent is closing');
    expect(aborts).toBe(1);
    await expect(runner.execute(baseConfig, 'status')).rejects.toThrow('runner is closed');
  });

  test('reports an explicit backup timeout and aborts the executor', async () => {
    const runner = new BunqueueBackupRunner(
      5,
      (_env, _operation, _key, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason));
        })
    );
    await expect(runner.execute(baseConfig, 'status')).rejects.toThrow('timed out after 5 ms');
    await runner.close();
  });

  test('handler shutdown releases every persistent resource exactly once', async () => {
    const closed = { workflow: 0, backup: 0, queue: 0 };
    const runtime = {
      close: async () => {
        closed.workflow++;
      },
    } as unknown as WorkflowRuntimePort;
    const backup = {
      close: async () => {
        closed.backup++;
      },
    } as unknown as BackupRunnerPort;
    const queue = {
      close: async () => {
        closed.queue++;
      },
    } as unknown as QueueOperationsPort;
    const handle = createFetchHandler(
      new ProcessManager(),
      { allowedOrigins: [] },
      runtime,
      backup,
      queue
    );
    await Promise.all([handle.close(), handle.close()]);
    expect(closed).toEqual({ workflow: 1, backup: 1, queue: 1 });
  });

  test('mounts queue operations through the handler with the running config', async () => {
    const running = { ...baseConfig, tcpPort: 7123 };
    const snapshot: StatusSnapshot = {
      status: 'running',
      generation: 1,
      pid: 123,
      startedAt: 1,
      exitCode: null,
      config: baseConfig,
      runningConfig: running,
    };
    const manager = {
      getStatus: () => snapshot,
      getConfig: () => baseConfig,
    } as unknown as ProcessManager;
    const calls: string[] = [];
    const queue = {
      limits: async (config: ServerConfig, name: string) => {
        calls.push(`${name}:${config.tcpPort}`);
        return { rateLimit: null, concurrency: 4, rateLimitTtl: 0, maxed: false };
      },
      close: async () => undefined,
    } as unknown as QueueOperationsPort;
    const handle = createFetchHandler(manager, { allowedOrigins: [] }, undefined, undefined, queue);
    const target = encodeURIComponent(`http://127.0.0.1:${running.httpPort}`);
    const response = await handle(
      new Request(`http://agent/queue-operations/emails/limits?target=${target}`)
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      limits: { concurrency: 4, maxed: false },
    });
    expect(calls).toEqual(['emails:7123']);
    await handle.close();
  });

  test('holds a stopped-server lease for the complete restore operation', async () => {
    const manager = new ProcessManager();
    const dataPath = temporaryPath('restore');
    manager.setConfig({ command: 'sleep 30', dataPath });
    const database = await manager.dbStats();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const runner: BackupRunnerPort = {
      execute: async () => {
        entered();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { success: true, message: 'restored' };
      },
      close: async () => undefined,
    };
    const handle = createFetchHandler(manager, { allowedOrigins: [] }, undefined, runner);
    const target = `http://127.0.0.1:${manager.getConfig().httpPort}`;
    const restoring = handle(
      new Request(`http://agent/backup/restore?target=${encodeURIComponent(target)}`, {
        method: 'POST',
        body: JSON.stringify({ key: 'backup.db', database }),
      })
    );
    await started;
    await expect(manager.start()).rejects.toThrow('while restoring a backup is running');
    release();
    expect((await restoring).status).toBe(200);
    expect((await manager.start()).status).toBe('running');
    await manager.stop();
    await handle.close();
  });

  test('reads workflow observability from runningConfig until restart', async () => {
    const desiredPath = workflowDatabase(0);
    const runningPath = workflowDatabase(1);
    const desired = { ...baseConfig, dataPath: desiredPath };
    const running = { ...baseConfig, dataPath: runningPath };
    const snapshot: StatusSnapshot = {
      status: 'running',
      generation: 1,
      pid: 123,
      startedAt: 1,
      exitCode: null,
      config: desired,
      runningConfig: running,
    };
    const manager = {
      getStatus: () => snapshot,
      getConfig: () => desired,
    } as unknown as ProcessManager;
    const handle = createFetchHandler(manager, { allowedOrigins: [] });
    const response = await handle(new Request('http://agent/workflows/stats'));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ activeTotal: 1 });
    await handle.close();
  });

  test('validates and reports effective workflow queue options while stopped', async () => {
    const runtime = new WorkflowRuntime();
    const status = await runtime.status(
      {
        ...baseConfig,
        extraEnv: {
          BUNQUEUE_WORKFLOW_MODULE: '/tmp/application-workflows.ts',
          BUNQUEUE_WORKFLOW_QUEUE_NAME: '__custom:steps',
          BUNQUEUE_WORKFLOW_CONCURRENCY: '17',
        },
      },
      false
    );
    expect(status).toMatchObject({ queueName: '__custom:steps', concurrency: 17 });
    const invalid = await runtime.status(
      {
        ...baseConfig,
        extraEnv: {
          BUNQUEUE_WORKFLOW_MODULE: '/tmp/application-workflows.ts',
          BUNQUEUE_WORKFLOW_CONCURRENCY: '1.5',
        },
      },
      false
    );
    expect(invalid.error).toContain('integer between 1 and 1000');
    await runtime.close();
  });
});

function temporaryPath(label: string): string {
  const path = `/tmp/bunqueue-dashboard-${label}-${crypto.randomUUID()}.db`;
  paths.push(path);
  return path;
}

function workflowDatabase(rows: number): string {
  const path = temporaryPath('running-config');
  const db = new Database(path, { create: true });
  db.run(`CREATE TABLE workflow_executions (
    id TEXT PRIMARY KEY, workflow_name TEXT NOT NULL, state TEXT NOT NULL,
    input BLOB, steps BLOB, current_node_index INTEGER NOT NULL,
    resolved_steps BLOB, signals BLOB, created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  if (rows) {
    db.query(`INSERT INTO workflow_executions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'running-1',
      'checkout',
      'running',
      null,
      null,
      0,
      null,
      null,
      1,
      1
    );
  }
  db.close();
  return path;
}
