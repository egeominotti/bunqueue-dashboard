import { describe, expect, test } from 'bun:test';
import type { BackupRunnerPort } from '../agent/backup/runner';
import type { ProcessManager, ServerConfig, StatusSnapshot } from '../agent/manager';
import type { QueueOperationsPort } from '../agent/queue/types';
import { createFetchHandler } from '../agent/server';
import type { WorkflowRuntimePort } from '../agent/workflow/runtime';

const config: ServerConfig = {
  command: 'bunqueue',
  httpPort: 6790,
  tcpPort: 6789,
  dataPath: '/tmp/agent-shutdown-coordination.db',
  extraEnv: {},
};
const status: StatusSnapshot = {
  status: 'running',
  generation: 1,
  pid: 41,
  startedAt: 1,
  exitCode: null,
  config,
  runningConfig: config,
};

describe('terminal agent shutdown', () => {
  test('waits active SDK leases, closes resources, then stops the managed process once', async () => {
    const events: string[] = [];
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const manager = {
      beginShutdown: () => {
        events.push('manager:latch');
      },
      getStatus: () => status,
      getConfig: () => config,
      shutdown: async () => {
        events.push('manager:shutdown');
        return { ...status, status: 'stopped' };
      },
    } as unknown as ProcessManager;
    const queue = {
      limits: async () => {
        events.push('sdk:start');
        entered();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        events.push('sdk:end');
        return { rateLimit: null, concurrency: null, rateLimitTtl: 0, maxed: false };
      },
      close: async () => {
        events.push('queue:close');
      },
    } as unknown as QueueOperationsPort;
    const handle = createFetchHandler(
      manager,
      { allowedOrigins: [] },
      closeResource<WorkflowRuntimePort>(events, 'workflow:close'),
      closeResource<BackupRunnerPort>(events, 'backup:close'),
      queue
    );
    const request = handle(
      new Request('http://agent/queue-operations/emails/limits?target=%2Fapi')
    );
    await started;

    const shuttingDown = handle.shutdown();
    expect(handle.shutdown()).toBe(shuttingDown);
    await Bun.sleep(0);
    expect(events).toEqual(['sdk:start', 'manager:latch']);
    expect((await handle(new Request('http://agent/control/status'))).status).toBe(503);
    release();

    expect((await request).status).toBe(200);
    await shuttingDown;
    expect(events).toEqual([
      'sdk:start',
      'manager:latch',
      'sdk:end',
      'workflow:close',
      'backup:close',
      'queue:close',
      'manager:shutdown',
    ]);
  });

  test('stops the manager after every resource settles even when cleanup rejects', async () => {
    const events: string[] = [];
    const manager = {
      beginShutdown: () => {
        events.push('manager:latch');
      },
      shutdown: async () => {
        events.push('manager:shutdown');
        return { ...status, status: 'stopped' };
      },
    } as unknown as ProcessManager;
    const runtime = {
      close: async () => {
        events.push('workflow:close');
        throw new Error('cached workflow close failure');
      },
    } as unknown as WorkflowRuntimePort;
    const handle = createFetchHandler(
      manager,
      { allowedOrigins: [] },
      runtime,
      closeResource<BackupRunnerPort>(events, 'backup:close'),
      closeResource<QueueOperationsPort>(events, 'queue:close')
    );

    await expect(handle.shutdown()).rejects.toThrow('cached workflow close failure');
    expect(events).toEqual([
      'manager:latch',
      'workflow:close',
      'backup:close',
      'queue:close',
      'manager:shutdown',
    ]);
  });

  test('attempts every resource close when an earlier close throws synchronously', async () => {
    const events: string[] = [];
    const manager = shutdownManager(events);
    const runtime = {
      close: () => {
        events.push('workflow:close');
        throw new Error('synchronous workflow close failure');
      },
    } as unknown as WorkflowRuntimePort;
    const handle = createFetchHandler(
      manager,
      { allowedOrigins: [] },
      runtime,
      closeResource<BackupRunnerPort>(events, 'backup:close'),
      closeResource<QueueOperationsPort>(events, 'queue:close')
    );

    await expect(handle.shutdown()).rejects.toThrow('synchronous workflow close failure');
    expect(events).toEqual([
      'manager:latch',
      'workflow:close',
      'backup:close',
      'queue:close',
      'manager:shutdown',
    ]);
  });

  test('preserves a falsy resource rejection instead of reporting success', async () => {
    const events: string[] = [];
    const runtime = {
      close: () => Promise.reject(undefined),
    } as unknown as WorkflowRuntimePort;
    const handle = createFetchHandler(
      shutdownManager(events),
      { allowedOrigins: [] },
      runtime,
      closeResource<BackupRunnerPort>(events, 'backup:close'),
      closeResource<QueueOperationsPort>(events, 'queue:close')
    );

    const rejection = await rejectedValue(handle.shutdown());
    expect(rejection.caught).toBeTrue();
    expect(rejection.error).toBeUndefined();
    expect(events).toContain('manager:shutdown');
  });

  test('latches shutdown before an already queued restart can spawn a replacement', async () => {
    const events: string[] = [];
    let latched = false;
    let spawned = 0;
    let current = status;
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const manager = {
      beginShutdown: () => {
        latched = true;
        events.push('manager:latch');
      },
      getStatus: () => current,
      getConfig: () => config,
      dbStats: async () => null,
      restart: async () => {
        events.push('manager:restart');
        current = stoppedStatus();
        if (!latched) {
          spawned++;
          current = { ...status, generation: 2, pid: 42 };
        }
        return current;
      },
      shutdown: async () => {
        events.push('manager:shutdown');
        current = stoppedStatus();
        return current;
      },
    } as unknown as ProcessManager;
    const queue = {
      limits: async () => {
        entered();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { rateLimit: null, concurrency: null, rateLimitTtl: 0, maxed: false };
      },
      close: async () => undefined,
    } as unknown as QueueOperationsPort;
    const handle = createFetchHandler(
      manager,
      { allowedOrigins: [] },
      closeResource<WorkflowRuntimePort>(events, 'workflow:close'),
      closeResource<BackupRunnerPort>(events, 'backup:close'),
      queue
    );
    const sdkRequest = handle(
      new Request('http://agent/queue-operations/emails/limits?target=%2Fapi')
    );
    await started;
    const restarting = handle(new Request('http://agent/control/restart', { method: 'POST' }));

    const shuttingDown = handle.shutdown();
    expect(latched).toBeTrue();
    release();

    expect((await sdkRequest).status).toBe(200);
    expect((await restarting).status).toBe(200);
    await shuttingDown;
    expect({ spawned, status: current.status }).toEqual({ spawned: 0, status: 'stopped' });
    expect(events.indexOf('manager:latch')).toBeLessThan(events.indexOf('manager:restart'));
  });
});

function closeResource<T>(events: string[], label: string): T {
  return {
    close: async () => {
      events.push(label);
    },
  } as T;
}

function shutdownManager(events: string[]): ProcessManager {
  return {
    beginShutdown: () => {
      events.push('manager:latch');
    },
    shutdown: async () => {
      events.push('manager:shutdown');
      return stoppedStatus();
    },
  } as unknown as ProcessManager;
}

function stoppedStatus(): StatusSnapshot {
  return { ...status, status: 'stopped', pid: null, startedAt: null, runningConfig: null };
}

async function rejectedValue(promise: Promise<unknown>) {
  try {
    await promise;
    return { caught: false, error: null };
  } catch (error) {
    return { caught: true, error };
  }
}
