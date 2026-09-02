import { describe, expect, test } from 'bun:test';
import type { BackupRunnerPort } from '../agent/backup/runner';
import type { DbStats, ProcessManager, ServerConfig, StatusSnapshot } from '../agent/manager';
import type { QueueOperationsPort } from '../agent/queue/types';
import { createFetchHandler } from '../agent/server';
import type { WorkflowRuntimePort } from '../agent/workflow/runtime';
import { createServeHandler } from '../scripts/serve';

const basePath = '/internal/queue';
const config: ServerConfig = {
  command: 'not-used',
  httpPort: 6790,
  tcpPort: 6789,
  dataPath: '/tmp/not-used.db',
  extraEnv: {},
};
const database: DbStats = {
  path: config.dataPath,
  exists: false,
  size: 0,
  walSize: 0,
  shmSize: 0,
  totalSize: 0,
  mtimeMs: null,
};
const snapshot: StatusSnapshot = {
  status: 'running',
  generation: 1,
  pid: 42,
  startedAt: 1,
  exitCode: null,
  config,
  runningConfig: config,
};

describe('base-path target-pinned agent routes', () => {
  test('accepts only the configured proxy alias across Flow, Workflow, Queue and Backup', async () => {
    const calls: string[] = [];
    const manager = fakeManager();
    const agent = createFetchHandler(
      manager,
      {
        allowedOrigins: [],
        managedProxyPath: `${basePath}/api`,
        managedProxyUrl: 'http://127.0.0.1:6790',
      },
      fakeWorkflow(calls),
      fakeBackup(calls),
      fakeQueue(calls)
    );
    const bridge = createServeHandler({
      api: 'http://127.0.0.1:6790',
      indexHtml: '<html>ok</html>',
      assets: {},
      agentHandle: agent,
      remoteAgentHandle: agent,
      allowedOrigins: [],
      agentBridge: true,
      agentTokenConfigured: false,
      basePath,
    });
    const target = encodeURIComponent(`${basePath}/api`);

    try {
      const flow = await bridge(
        new Request(`http://localhost${basePath}/agent/flows/tree?queueName=q&target=${target}`)
      );
      expect(flow.status).toBe(400);
      expect(await flow.json()).toMatchObject({ error: 'Flow id is required' });

      const workflow = await bridge(
        new Request(`http://localhost${basePath}/agent/workflows/runtime?target=${target}`)
      );
      expect(workflow.status).toBe(200);

      const queue = await bridge(
        new Request(
          `http://localhost${basePath}/agent/queue-operations/q/events/trim?target=${target}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ maxLength: 7 }),
          }
        )
      );
      expect(queue.status).toBe(200);

      const backup = await bridge(
        new Request(`http://localhost${basePath}/agent/backup/status?target=${target}`)
      );
      expect(backup.status).toBe(200);
      expect(calls).toEqual(['workflow:status', 'queue:trim:q:7', 'backup:status']);

      for (const rejectedTarget of ['/other/api', 'https://attacker.example/api']) {
        const rejected = await bridge(
          new Request(
            `http://localhost${basePath}/agent/workflows/runtime?target=${encodeURIComponent(rejectedTarget)}`
          )
        );
        expect(rejected.status).toBe(400);
        expect(((await rejected.json()) as { error: string }).error).toContain(
          rejectedTarget.startsWith('/') ? 'absolute local HTTP URL' : 'does not match'
        );
      }
      expect(calls).toEqual(['workflow:status', 'queue:trim:q:7', 'backup:status']);
    } finally {
      await agent.close();
    }
  });

  test('rejects ambiguous configured proxy aliases before serving requests', () => {
    for (const managedProxyPath of [
      '//attacker.example/api',
      '/internal/../api',
      '/internal//api',
      '/internal/not-api',
    ]) {
      expect(() =>
        createFetchHandler(fakeManager(), {
          allowedOrigins: [],
          managedProxyPath,
        })
      ).toThrow('Managed proxy path');
    }
  });
});

function fakeManager(): ProcessManager {
  return {
    getStatus: () => snapshot,
    getConfig: () => config,
    dbStats: async () => database,
  } as unknown as ProcessManager;
}

function fakeWorkflow(calls: string[]): WorkflowRuntimePort {
  return {
    status: async () => {
      calls.push('workflow:status');
      return { configured: false, ready: false, workflowNames: [] };
    },
    reload: async () => ({ configured: false, ready: false, workflowNames: [] }),
    start: async () => ({}),
    signal: async () => undefined,
    recover: async () => ({}),
    resumeCompensation: async () => undefined,
    abandonCompensation: async () => undefined,
    archive: async () => 0,
    cleanup: async () => 0,
    close: async () => undefined,
  };
}

function fakeBackup(calls: string[]): BackupRunnerPort {
  return {
    execute: async (_config, operation) => {
      calls.push(`backup:${operation}`);
      return { success: true, message: 'ok' };
    },
    close: async () => undefined,
  };
}

function fakeQueue(calls: string[]): QueueOperationsPort {
  return {
    limits: async () => ({
      rateLimit: null,
      concurrency: null,
      rateLimitTtl: -1,
      maxed: false,
    }),
    group: async () => ({
      jobs: 0,
      active: 0,
      totalGrouped: 0,
      paused: false,
      entries: [],
      priorityCounts: {},
      rateLimit: null,
      rateLimitTtl: -2,
      concurrency: null,
    }),
    pauseGroup: async () => false,
    resumeGroup: async () => false,
    setGroupRateLimit: async () => undefined,
    removeGroupRateLimit: async () => 0,
    setGroupConcurrency: async () => undefined,
    removeGroupConcurrency: async () => 0,
    deduplicationJobId: async () => null,
    removeDeduplicationKey: async () => 0,
    metrics: async () => ({ meta: { count: 0, prevTS: 0, prevCount: 0 }, data: [], count: 0 }),
    trimEvents: async (_config, queue, maxLength) => {
      calls.push(`queue:trim:${queue}:${maxLength}`);
      return 0;
    },
    close: async () => undefined,
  };
}
