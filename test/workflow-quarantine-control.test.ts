import { describe, expect, test } from 'bun:test';
import type { BackupRunnerPort } from '../agent/backup/runner';
import type { ProcessManager, ServerConfig, StatusSnapshot } from '../agent/manager';
import type { QueueOperationsPort } from '../agent/queue/types';
import { createFetchHandler } from '../agent/server';
import {
  type WorkflowRuntimePort,
  WorkflowRuntimeUnavailableError,
} from '../agent/workflow/runtime';

const config: ServerConfig = {
  command: 'bunqueue',
  httpPort: 1,
  tcpPort: 6789,
  dataPath: '/tmp/workflow-quarantine-control.db',
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

describe('Workflow quarantine control safety', () => {
  for (const operation of ['stop', 'restart'] as const) {
    test(`stops the managed process when Engine close fails during ${operation}`, async () => {
      let current = running;
      let stops = 0;
      let restarts = 0;
      const manager = {
        getStatus: () => current,
        getConfig: () => config,
        dbStats: async () => null,
        stop: async () => {
          stops++;
          current = {
            ...running,
            status: 'stopped',
            pid: null,
            startedAt: null,
            runningConfig: null,
          };
          return current;
        },
        restart: async () => {
          restarts++;
          return current;
        },
      } as unknown as ProcessManager;
      const runtime = {
        close: async () => {
          throw new WorkflowRuntimeUnavailableError('Workflow Engine is quarantined');
        },
      } as unknown as WorkflowRuntimePort;
      const handle = createFetchHandler(
        manager,
        { allowedOrigins: [] },
        runtime,
        closeOnly<BackupRunnerPort>(),
        closeOnly<QueueOperationsPort>()
      );

      const response = await handle(
        new Request(`http://agent/control/${operation}`, { method: 'POST' })
      );

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: expect.stringContaining('quarantined'),
      });
      expect({ status: current.status, stops, restarts }).toEqual({
        status: 'stopped',
        stops: 1,
        restarts: 0,
      });
      await expect(handle.close()).rejects.toThrow('quarantined');
    });

    test(`fails closed when Engine cleanup rejects undefined during ${operation}`, async () => {
      let current = running;
      let stops = 0;
      let restarts = 0;
      const manager = {
        getStatus: () => current,
        getConfig: () => config,
        dbStats: async () => null,
        stop: async () => {
          stops++;
          current = stopped();
          return current;
        },
        restart: async () => {
          restarts++;
          return current;
        },
      } as unknown as ProcessManager;
      const runtime = {
        close: () => Promise.reject(undefined),
      } as unknown as WorkflowRuntimePort;
      const handle = createFetchHandler(
        manager,
        { allowedOrigins: [] },
        runtime,
        closeOnly<BackupRunnerPort>(),
        closeOnly<QueueOperationsPort>()
      );

      const response = await handle(
        new Request(`http://agent/control/${operation}`, { method: 'POST' })
      );

      expect(response.status).toBe(503);
      expect({ status: current.status, stops, restarts }).toEqual({
        status: 'stopped',
        stops: 1,
        restarts: 0,
      });
    });

    test(`fails closed when Engine cleanup rejects a non-coercible value during ${operation}`, async () => {
      let current = running;
      let stops = 0;
      let restarts = 0;
      const manager = {
        getStatus: () => current,
        getConfig: () => config,
        dbStats: async () => null,
        stop: async () => {
          stops++;
          current = stopped();
          return current;
        },
        restart: async () => {
          restarts++;
          return current;
        },
      } as unknown as ProcessManager;
      const runtime = {
        close: () => Promise.reject(nonCoercibleFailure()),
      } as unknown as WorkflowRuntimePort;
      const handle = createFetchHandler(
        manager,
        { allowedOrigins: [] },
        runtime,
        closeOnly<BackupRunnerPort>(),
        closeOnly<QueueOperationsPort>()
      );

      const response = await handle(
        new Request(`http://agent/control/${operation}`, { method: 'POST' })
      );

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: expect.stringContaining('Unprintable error'),
      });
      expect({ status: current.status, stops, restarts }).toEqual({
        status: 'stopped',
        stops: 1,
        restarts: 0,
      });
    });
  }
});

function stopped(): StatusSnapshot {
  return { ...running, status: 'stopped', pid: null, startedAt: null, runningConfig: null };
}

function closeOnly<T>(): T {
  return { close: async () => undefined } as T;
}

function nonCoercibleFailure(): object {
  return {
    [Symbol.toPrimitive]() {
      throw new Error('coercion exploded');
    },
  };
}
