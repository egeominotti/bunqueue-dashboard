import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { Engine } from 'bunqueue/workflow';
import type { ServerConfig } from '../agent/manager';
import { WorkflowRuntime } from '../agent/workflow/runtime';

const config: ServerConfig = {
  command: 'bunqueue',
  httpPort: 6790,
  tcpPort: 6789,
  dataPath: '/tmp/workflow-runtime-init-quarantine.db',
  extraEnv: {
    BUNQUEUE_WORKFLOW_MODULE: join(import.meta.dir, 'fixtures/workflow-runtime.ts'),
  },
};

describe('Workflow runtime initialization quarantine', () => {
  test('never replaces an Engine whose failed initialization cannot be cleaned up', async () => {
    let creations = 0;
    let closeCalls = 0;
    let closeAttempts = 0;
    let closing: Promise<void> | null = null;
    const engine = {
      register: () => {
        throw new Error('synthetic workflow registration failure');
      },
      close: () => {
        closeCalls++;
        if (!closing) {
          closeAttempts++;
          closing = Promise.reject(new Error('synthetic cached cleanup failure'));
        }
        return closing;
      },
    } as unknown as Engine;
    const runtime = new WorkflowRuntime(() => {
      creations++;
      return engine;
    });

    const first = await runtime.status(config);
    expect(first).toMatchObject({ ready: false, configured: true });
    expect(first.error).toContain('synthetic workflow registration failure');
    expect(first.error).toContain('synthetic cached cleanup failure');

    const second = await runtime.status(config);
    expect(second).toMatchObject({ ready: false, error: first.error });
    const command = await rejectionOf(runtime.start(config, 'dashboard-instant-e2e'));
    expect(command.message).toContain('synthetic workflow registration failure');
    expect(command.message).toContain('synthetic cached cleanup failure');
    const reload = await rejectionOf(runtime.reload(config));
    expect(reload.message).toContain('synthetic cached cleanup failure');
    const close = await rejectionOf(runtime.close());
    expect(close.message).toContain('synthetic cached cleanup failure');
    expect({ creations, closeCalls, closeAttempts }).toEqual({
      creations: 1,
      closeCalls: 3,
      closeAttempts: 1,
    });
  });

  test('cleans up and quarantines when initialization throws a non-coercible value', async () => {
    let creations = 0;
    let closeCalls = 0;
    const hostile = nonCoercibleFailure();
    const engine = {
      register: () => {
        throw hostile;
      },
      close: () => {
        closeCalls++;
        return Promise.reject(hostile);
      },
    } as unknown as Engine;
    const runtime = new WorkflowRuntime(() => {
      creations++;
      return engine;
    });

    const first = await runtime.status(config);
    const second = await runtime.status(config);

    expect(first).toMatchObject({
      ready: false,
      error: expect.stringContaining('Unprintable error'),
    });
    expect(second).toEqual(first);
    expect({ creations, closeCalls }).toEqual({ creations: 1, closeCalls: 1 });
  });
});

async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error('Expected operation to reject');
}

function nonCoercibleFailure(): object {
  return {
    [Symbol.toPrimitive]() {
      throw new Error('coercion exploded');
    },
  };
}
