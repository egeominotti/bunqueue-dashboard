import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { Engine } from 'bunqueue/workflow';
import type { ProcessManager, ServerConfig, StatusSnapshot } from '../agent/manager';
import { createFetchHandler } from '../agent/server';
import {
  WorkflowRuntime,
  type WorkflowRuntimePort,
  type WorkflowRuntimeStatus,
} from '../agent/workflow/runtime';

const config: ServerConfig = {
  command: 'bunqueue',
  httpPort: 6790,
  tcpPort: 6789,
  dataPath: '/tmp/workflow-runtime-lifecycle.db',
  extraEnv: {},
};
const snapshot: StatusSnapshot = {
  status: 'stopped',
  generation: 0,
  pid: null,
  startedAt: null,
  exitCode: null,
  config,
  runningConfig: null,
};

describe('workflow runtime lifecycle', () => {
  test('quarantines an Engine after its cached close promise rejects', async () => {
    let creations = 0;
    let closeCalls = 0;
    let closeAttempts = 0;
    let closing: Promise<void> | null = null;
    const engine: Engine = {
      register: () => engine,
      close: () => {
        closeCalls++;
        if (!closing) {
          closeAttempts++;
          closing = Promise.reject(new Error(''));
        }
        return closing;
      },
    } as unknown as Engine;
    const runtime = new WorkflowRuntime(() => {
      creations++;
      return engine;
    });
    const configured = {
      ...config,
      extraEnv: {
        BUNQUEUE_WORKFLOW_MODULE: join(import.meta.dir, 'fixtures/workflow-runtime.ts'),
      },
    };

    expect((await runtime.status(configured)).ready).toBeTrue();
    await expect(runtime.close()).rejects.toThrow('quarantined');
    expect(await runtime.status(configured)).toMatchObject({
      ready: false,
      error: expect.stringContaining('quarantined'),
    });
    await expect(runtime.start(configured, 'dashboard-instant-e2e')).rejects.toThrow('quarantined');
    await expect(runtime.reload(configured)).rejects.toThrow('quarantined');
    await expect(runtime.close()).rejects.toThrow('quarantined');
    expect({ creations, closeCalls, closeAttempts }).toEqual({
      creations: 1,
      closeCalls: 3,
      closeAttempts: 1,
    });
  });

  test('closes persistent Engine resources before managed stop and restart', async () => {
    const events: string[] = [];
    const manager = {
      getStatus: () => snapshot,
      getConfig: () => config,
      dbStats: async () => ({
        path: config.dataPath,
        exists: false,
        size: 0,
        walSize: 0,
        shmSize: 0,
        totalSize: 0,
        mtimeMs: 0,
      }),
      stop: async () => {
        events.push('stop');
        return snapshot;
      },
      restart: async () => {
        events.push('restart');
        return snapshot;
      },
    } as unknown as ProcessManager;
    const runtime = fakeRuntime(async () => {
      events.push('close');
    });
    const handle = createFetchHandler(manager, { allowedOrigins: [] }, runtime);

    expect(
      (await handle(new Request('http://agent/control/stop', { method: 'POST' }))).status
    ).toBe(200);
    expect(
      (await handle(new Request('http://agent/control/restart', { method: 'POST' }))).status
    ).toBe(200);
    expect(events).toEqual(['close', 'stop', 'close', 'restart']);
  });

  test('rejects a command whose body finishes after managed stop closes the runtime', async () => {
    const running: StatusSnapshot = {
      ...snapshot,
      status: 'running',
      generation: 1,
      pid: 42,
      startedAt: 1,
      runningConfig: config,
    };
    let current = running;
    let starts = 0;
    let closes = 0;
    const manager = {
      getStatus: () => current,
      getConfig: () => config,
      dbStats: async () => ({
        path: config.dataPath,
        exists: false,
        size: 0,
        walSize: 0,
        shmSize: 0,
        totalSize: 0,
        mtimeMs: 0,
      }),
      stop: async () => {
        current = snapshot;
        return current;
      },
    } as unknown as ProcessManager;
    const runtime = fakeRuntime(async () => {
      closes += 1;
    });
    runtime.start = async () => {
      starts += 1;
      return { id: 'too-late' };
    };
    const handle = createFetchHandler(manager, { allowedOrigins: [] }, runtime);
    const body = delayedWorkflowBody();
    const starting = handle(
      new Request('http://agent/workflows/start?target=%2Fapi', {
        method: 'POST',
        body: body.stream,
      })
    );

    await body.reading;
    const stopped = await handle(new Request('http://agent/control/stop', { method: 'POST' }));
    body.release();
    const rejected = await starting;

    expect(stopped.status).toBe(200);
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({
      ok: false,
      error: expect.stringContaining('Start the managed Bunqueue server'),
    });
    expect({ starts, closes, status: current.status }).toEqual({
      starts: 0,
      closes: 1,
      status: 'stopped',
    });
    await handle.close();
  });

  test('does not carry a delayed Workflow command across a managed restart', async () => {
    const raceConfig = { ...config, httpPort: 1 };
    const running: StatusSnapshot = {
      ...snapshot,
      status: 'running',
      generation: 1,
      pid: 42,
      startedAt: 1,
      config: raceConfig,
      runningConfig: raceConfig,
    };
    let current = running;
    let starts = 0;
    let closes = 0;
    const manager = {
      getStatus: () => current,
      getConfig: () => raceConfig,
      dbStats: async () => ({
        path: raceConfig.dataPath,
        exists: false,
        size: 0,
        walSize: 0,
        shmSize: 0,
        totalSize: 0,
        mtimeMs: 0,
      }),
      restart: async () => {
        current = { ...running, generation: 2, pid: 43, startedAt: 2 };
        return current;
      },
    } as unknown as ProcessManager;
    const runtime = fakeRuntime(async () => {
      closes += 1;
    });
    runtime.start = async () => {
      starts += 1;
      return { id: 'wrong-generation' };
    };
    const handle = createFetchHandler(manager, { allowedOrigins: [] }, runtime);
    const body = delayedWorkflowBody();
    const starting = handle(
      new Request('http://agent/workflows/start?target=http%3A%2F%2F127.0.0.1%3A1', {
        method: 'POST',
        body: body.stream,
      })
    );

    await body.reading;
    const restarted = await handle(new Request('http://agent/control/restart', { method: 'POST' }));
    body.release();
    const rejected = await starting;
    const rejection = await rejected.json();

    expect(restarted.status).toBe(200);
    expect(rejection).toMatchObject({
      error: expect.stringContaining('restarted while the request was prepared'),
    });
    expect(rejected.status).toBe(409);
    expect({ starts, closes, pid: current.pid }).toEqual({ starts: 0, closes: 1, pid: 43 });
    await handle.close();
  });
});

function delayedWorkflowBody() {
  let announce!: () => void;
  let release!: () => void;
  const reading = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  let sent = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (sent) return;
      sent = true;
      announce();
      await ready;
      controller.enqueue(new TextEncoder().encode('{"workflowName":"checkout"}'));
      controller.close();
    },
  });
  return { stream, reading, release };
}

function fakeRuntime(close: () => Promise<void>): WorkflowRuntimePort {
  const status: WorkflowRuntimeStatus = { configured: false, ready: false, workflowNames: [] };
  return {
    status: async () => status,
    reload: async () => status,
    start: async () => ({}),
    signal: async () => undefined,
    recover: async () => ({}),
    resumeCompensation: async () => undefined,
    abandonCompensation: async () => undefined,
    archive: async () => 0,
    cleanup: async () => 0,
    close,
  };
}
