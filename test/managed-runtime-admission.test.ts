import { describe, expect, test } from 'bun:test';
import type { BackupRunnerPort } from '../agent/backup/runner';
import { type FlowOperationsPort, routeFlowRequest } from '../agent/flow/routes';
import type { ProcessManager, ServerConfig, StatusSnapshot } from '../agent/manager';
import type { QueueOperationsPort } from '../agent/queue/types';
import { createFetchHandler } from '../agent/server';
import { AgentLifecycleGate } from '../agent/server/lifecycle';
import { managedRuntimeAdmission } from '../agent/server/managedRuntime';
import type { WorkflowRuntimePort } from '../agent/workflow/runtime';

const config: ServerConfig = {
  command: 'bunqueue',
  httpPort: 1,
  tcpPort: 6789,
  dataPath: '/tmp/managed-runtime-admission.db',
  extraEnv: {},
};
const running: StatusSnapshot = {
  status: 'running',
  generation: 1,
  pid: 41,
  startedAt: 1,
  exitCode: null,
  config,
  runningConfig: config,
};

describe('managed SDK runtime admission', () => {
  test('PostgreSQL mode hides SQLite-only status, inspection, and backup operations', async () => {
    const postgresConfig: ServerConfig = {
      ...config,
      extraEnv: {
        BUNQUEUE_STORAGE_DRIVER: 'postgres',
        BUNQUEUE_POSTGRES_URL: 'postgres://example.invalid/bunqueue',
      },
    };
    const postgresRunning: StatusSnapshot = {
      ...running,
      config: postgresConfig,
      runningConfig: postgresConfig,
    };
    const harness = managerHarness(postgresRunning);
    let dbReads = 0;
    harness.dbStats = async () => {
      dbReads++;
      return null;
    };
    const handle = createFetchHandler(
      harness as unknown as ProcessManager,
      { allowedOrigins: [] },
      workflowRuntime(),
      backupRunner(),
      { close: async () => undefined } as QueueOperationsPort
    );

    const status = await handle(new Request(`${agentTarget()}/control/status`));
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      db: null,
      storageMode: 'postgres',
      postgresNamespace: 'default',
    });
    for (const path of ['/db/info', '/backup/status']) {
      const response = await handle(new Request(`${agentTarget()}${path}`));
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: expect.stringContaining('SQLite') });
    }
    expect(dbReads).toBe(0);
    await handle.close();
  });

  test('rejects a Queue mutation whose body completes after restart', async () => {
    const harness = managerHarness(running);
    let trims = 0;
    const queue = {
      trimEvents: async () => {
        trims++;
        return 1;
      },
      close: async () => undefined,
    } as unknown as QueueOperationsPort;
    harness.restart = async () => {
      harness.current = { ...running, generation: 2 };
      return harness.current;
    };
    const handle = createFetchHandler(
      harness as unknown as ProcessManager,
      { allowedOrigins: [] },
      workflowRuntime(),
      backupRunner(),
      queue
    );
    const body = delayedJsonBody('{"maxLength":100}');
    const trimming = handle(
      new Request(`${agentTarget()}/queue-operations/emails/events/trim?target=${target()}`, {
        method: 'POST',
        body: body.stream,
      })
    );

    await body.reading;
    const restarted = await handle(
      new Request(`${agentTarget()}/control/restart`, { method: 'POST' })
    );
    body.release();
    const rejected = await trimming;

    expect(restarted.status).toBe(200);
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({
      error: expect.stringContaining('restarted while the request was prepared'),
    });
    expect(trims).toBe(0);
    await handle.close();
  });

  test('rejects a Flow command whose body completes after stop', async () => {
    const harness = managerHarness(running);
    const lifecycle = new AgentLifecycleGate();
    const admission = managedRuntimeAdmission(
      harness as unknown as ProcessManager,
      lifecycle,
      running
    );
    let creates = 0;
    const operations = flowOperations(() => {
      creates++;
    });
    const body = delayedJsonBody('{"operation":"add","flow":{}}');
    const creating = routeFlowRequest(
      new Request(`${agentTarget()}/flows/create?target=${target()}`, {
        method: 'POST',
        body: body.stream,
      }),
      '/flows/create',
      'POST',
      config,
      true,
      { admission, operations }
    );

    await body.reading;
    await lifecycle.run(async () => {
      harness.current = { ...running, status: 'stopped', pid: null, runningConfig: null };
    });
    body.release();

    await expect(creating).rejects.toThrow('Start the managed Bunqueue server');
    expect(creates).toBe(0);
  });

  test('runs SDK leases concurrently and lets a queued restart wait for the batch', async () => {
    const harness = managerHarness(running);
    let release!: () => void;
    let entered!: () => void;
    let entries = 0;
    let restarts = 0;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const queue = {
      limits: async () => {
        entries++;
        if (entries === 2) entered();
        await new Promise<void>((resolve) => {
          const previous = release;
          release = () => {
            previous?.();
            resolve();
          };
        });
        return { rateLimit: null, concurrency: null, rateLimitTtl: 0, maxed: false };
      },
      close: async () => undefined,
    } as unknown as QueueOperationsPort;
    harness.restart = async () => {
      restarts++;
      harness.current = { ...running, generation: 2 };
      return harness.current;
    };
    const handle = createFetchHandler(
      harness as unknown as ProcessManager,
      { allowedOrigins: [] },
      workflowRuntime(),
      backupRunner(),
      queue
    );
    const readings = ['emails', 'reports'].map((queueName) =>
      handle(
        new Request(`${agentTarget()}/queue-operations/${queueName}/limits?target=${target()}`)
      )
    );

    await started;
    const restarting = handle(new Request(`${agentTarget()}/control/restart`, { method: 'POST' }));
    await Bun.sleep(0);
    expect(restarts).toBe(0);
    release();

    expect((await Promise.all(readings)).map((response) => response.status)).toEqual([200, 200]);
    expect((await restarting).status).toBe(200);
    expect(restarts).toBe(1);
    await handle.close();
  });
});

function managerHarness(initial: StatusSnapshot) {
  return {
    current: initial,
    getStatus() {
      return this.current;
    },
    getConfig() {
      return this.current.runningConfig ?? this.current.config;
    },
    dbStats: async () => null,
    restart: async () => initial,
  };
}

function workflowRuntime(): WorkflowRuntimePort {
  return { close: async () => undefined } as unknown as WorkflowRuntimePort;
}

function backupRunner(): BackupRunnerPort {
  return { close: async () => undefined } as unknown as BackupRunnerPort;
}

function flowOperations(onCreate: () => void): FlowOperationsPort {
  return {
    create: async () => {
      onCreate();
      return {};
    },
    inspect: async () => ({}),
    mutate: async () => ({}),
    parentResults: async () => ({}),
    read: async () => ({}),
    wait: async () => ({}),
  };
}

function delayedJsonBody(json: string) {
  let announce!: () => void;
  let release!: () => void;
  const reading = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      announce();
      await ready;
      controller.enqueue(new TextEncoder().encode(json));
      controller.close();
    },
  });
  return { reading, release, stream };
}

function agentTarget(): string {
  return 'http://agent';
}

function target(): string {
  return encodeURIComponent('http://127.0.0.1:1');
}
