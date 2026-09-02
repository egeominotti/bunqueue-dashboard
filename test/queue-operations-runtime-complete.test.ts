import { describe, expect, test } from 'bun:test';
import type { Job } from 'bunqueue/client';
import type { ServerConfig } from '../agent/manager';
import { type QueueOperationsClient, QueueOperationsRuntime } from '../agent/queue/runtime';

const config: ServerConfig = {
  command: 'bunqueue',
  httpPort: 6790,
  tcpPort: 6789,
  dataPath: '/tmp/queue-runtime.db',
  extraEnv: {},
};

function fakeClient(log: string[]): QueueOperationsClient {
  return {
    waitUntilReady: async () => {
      log.push('ready');
    },
    getGlobalRateLimit: async () => {
      log.push('global-rate');
      return { max: 10, duration: 1_000 };
    },
    getGlobalConcurrency: async () => {
      log.push('global-concurrency');
      return 4;
    },
    getRateLimitTtl: async (maxJobs) => {
      log.push(`rate-ttl:${maxJobs}`);
      return 75;
    },
    isMaxed: async () => {
      log.push('maxed');
      return true;
    },
    getGroupJobsCount: async (groupId) => {
      log.push(`group-jobs:${groupId}`);
      return 7;
    },
    getGroupsJobsCount: async (maxCount) => {
      log.push(`groups-jobs:${maxCount}`);
      return 18;
    },
    getGroupActiveCount: async (groupId) => {
      log.push(`group-active:${groupId}`);
      return 2;
    },
    setGroupRateLimit: async (groupId, max, duration) => {
      log.push(`set-group-rate:${groupId}:${max}:${duration}`);
    },
    getGroupRateLimit: async (groupId) => {
      log.push(`group-rate:${groupId}`);
      return { max: 5, duration: 2_000 };
    },
    removeGroupRateLimit: async (groupId) => {
      log.push(`remove-group-rate:${groupId}`);
      return 1;
    },
    getGroupRateLimitTtl: async (groupId, maxJobs) => {
      log.push(`group-rate-ttl:${groupId}:${maxJobs}`);
      return 25;
    },
    setGroupConcurrency: async (groupId, concurrency) => {
      log.push(`set-group-concurrency:${groupId}:${concurrency}`);
    },
    getGroupConcurrency: async (groupId) => {
      log.push(`group-concurrency:${groupId}`);
      return 3;
    },
    removeGroupConcurrency: async (groupId) => {
      log.push(`remove-group-concurrency:${groupId}`);
      return 1;
    },
    pauseGroup: async (groupId) => {
      log.push(`pause-group:${groupId}`);
      return true;
    },
    resumeGroup: async (groupId) => {
      log.push(`resume-group:${groupId}`);
      return true;
    },
    isGroupPaused: async (groupId) => {
      log.push(`group-paused:${groupId}`);
      return true;
    },
    getGroupJobs: async (groupId, start, end) => {
      log.push(`group-list:${groupId}:${start}:${end}`);
      return [
        {
          id: 'group-job-7',
          name: 'deliver',
          priority: 2,
          delay: 50,
          timestamp: 100,
        } as Job,
      ];
    },
    getCountsPerPriorityForGroup: async (groupId) => {
      log.push(`group-priorities:${groupId}`);
      return { 2: 1 };
    },
    getDeduplicationJobId: async (id) => {
      log.push(`dedup:${id}`);
      return 'job-7';
    },
    removeDeduplicationKey: async (id) => {
      log.push(`remove-dedup:${id}`);
      return 1;
    },
    removeDlqJob: async (id) => {
      log.push(`remove-dlq:${id}`);
      return true;
    },
    getMetrics: async (type, start, end) => {
      log.push(`metrics:${type}:${start}:${end}`);
      return { meta: { count: 9, prevTS: 10, prevCount: 2 }, data: [3, 4], count: 2 };
    },
    trimEvents: async (maxLength) => {
      log.push(`trim:${maxLength}`);
      return 6;
    },
    close: () => {
      log.push('close');
    },
  };
}

describe('Queue SDK runtime complete method surface', () => {
  test('executes every read and mutation through a ready, dedicated, closed client', async () => {
    const log: string[] = [];
    const queues: string[] = [];
    const runtime = new QueueOperationsRuntime((_config, queue) => {
      queues.push(queue);
      return fakeClient(log);
    });

    expect(await runtime.limits(config, 'orders', 3)).toEqual({
      rateLimit: { max: 10, duration: 1_000 },
      concurrency: 4,
      rateLimitTtl: 75,
      maxed: true,
    });
    expect(await runtime.group(config, 'orders', 'tenant-7', 2, 50, 10, 19)).toEqual({
      jobs: 7,
      active: 2,
      totalGrouped: 18,
      paused: true,
      entries: [{ id: 'group-job-7', name: 'deliver', priority: 2, delay: 50, timestamp: 100 }],
      priorityCounts: { '2': 1 },
      rateLimit: { max: 5, duration: 2_000 },
      rateLimitTtl: 25,
      concurrency: 3,
    });
    await runtime.setGroupRateLimit(config, 'orders', 'tenant-7', 5, 2_000);
    expect(await runtime.removeGroupRateLimit(config, 'orders', 'tenant-7')).toBe(1);
    await runtime.setGroupConcurrency(config, 'orders', 'tenant-7', 3);
    expect(await runtime.removeGroupConcurrency(config, 'orders', 'tenant-7')).toBe(1);
    expect(await runtime.pauseGroup(config, 'orders', 'tenant-7')).toBe(true);
    expect(await runtime.resumeGroup(config, 'orders', 'tenant-7')).toBe(true);
    expect(await runtime.deduplicationJobId(config, 'orders', 'invoice:7')).toBe('job-7');
    expect(await runtime.removeDeduplicationKey(config, 'orders', 'invoice:7')).toBe(1);
    expect(await runtime.removeDlqJob(config, 'orders', 'job-7')).toBe(true);
    expect(await runtime.metrics(config, 'orders', 'failed', 2, 8)).toEqual({
      meta: { count: 9, prevTS: 10, prevCount: 2 },
      data: [3, 4],
      count: 2,
    });
    expect(await runtime.trimEvents(config, 'orders', 250)).toBe(6);

    expect(queues).toEqual(Array.from({ length: 13 }, () => 'orders'));
    expect(log.filter((entry) => entry === 'ready')).toHaveLength(13);
    expect(log.filter((entry) => entry === 'close')).toHaveLength(13);
    expect(log).toContain('rate-ttl:3');
    expect(log).toContain('groups-jobs:50');
    expect(log).toContain('set-group-rate:tenant-7:5:2000');
    expect(log).toContain('set-group-concurrency:tenant-7:3');
    expect(log).toContain('group-list:tenant-7:10:19');
    expect(log).toContain('group-priorities:tenant-7');
    expect(log).toContain('pause-group:tenant-7');
    expect(log).toContain('resume-group:tenant-7');
    expect(log).toContain('remove-dlq:job-7');
    expect(log).toContain('metrics:failed:2:8');
  });

  test('closes a client even when readiness or an operation rejects', async () => {
    let closed = 0;
    const base = fakeClient([]);
    const runtime = new QueueOperationsRuntime(() => ({
      ...base,
      waitUntilReady: async () => {
        throw new Error('TCP unavailable');
      },
      close: () => {
        closed++;
      },
    }));
    await expect(runtime.limits(config, 'orders')).rejects.toThrow('TCP unavailable');
    expect(closed).toBe(1);

    const runtime2 = new QueueOperationsRuntime(() => ({
      ...base,
      getDeduplicationJobId: async () => {
        throw new Error('protocol error');
      },
      close: () => {
        closed++;
      },
    }));
    await expect(runtime2.deduplicationJobId(config, 'orders', 'key')).rejects.toThrow(
      'protocol error'
    );
    expect(closed).toBe(2);
  });
});
