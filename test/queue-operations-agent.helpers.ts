import type { ServerConfig } from '../agent/manager';
import type { QueueOperationsPort } from '../agent/queue/types';

export const config: ServerConfig = {
  command: 'bunqueue',
  httpPort: 6790,
  tcpPort: 6789,
  dataPath: '/tmp/not-used.db',
  extraEnv: {},
};

export function fakeRuntime(calls: string[]): QueueOperationsPort {
  return {
    limits: async (_config, queue, maxJobs) => {
      calls.push(`limits:${queue}:${maxJobs}`);
      return {
        rateLimit: { max: 12, duration: 1000 },
        concurrency: 4,
        rateLimitTtl: 80,
        maxed: false,
      };
    },
    group: async (_config, queue, groupId, maxJobs, maxCount) => {
      calls.push(`group:${queue}:${groupId}:${maxJobs}:${maxCount}`);
      return {
        jobs: 2,
        active: 1,
        totalGrouped: 4,
        rateLimit: { max: 5, duration: 1000 },
        rateLimitTtl: 20,
        concurrency: 3,
      };
    },
    setGroupRateLimit: async (_config, queue, groupId, max, duration) => {
      calls.push(`group-rate:${queue}:${groupId}:${max}:${duration}`);
    },
    removeGroupRateLimit: async (_config, queue, groupId) => {
      calls.push(`group-rate-remove:${queue}:${groupId}`);
      return 1;
    },
    setGroupConcurrency: async (_config, queue, groupId, concurrency) => {
      calls.push(`group-concurrency:${queue}:${groupId}:${concurrency}`);
    },
    removeGroupConcurrency: async (_config, queue, groupId) => {
      calls.push(`group-concurrency-remove:${queue}:${groupId}`);
      return 1;
    },
    deduplicationJobId: async (_config, queue, id) => {
      calls.push(`dedup:${queue}:${id}`);
      return 'job-7';
    },
    removeDeduplicationKey: async (_config, queue, id) => {
      calls.push(`remove:${queue}:${id}`);
      return 1;
    },
    removeDlqJob: async (_config, queue, id) => {
      calls.push(`remove-dlq:${queue}:${id}`);
      return true;
    },
    metrics: async (_config, queue, type, start, end) => {
      calls.push(`metrics:${queue}:${type}:${start}:${end}`);
      return { meta: { count: 7, prevTS: 10, prevCount: 2 }, data: [2, 1], count: 2 };
    },
    trimEvents: async (_config, queue, maxLength) => {
      calls.push(`trim:${queue}:${maxLength}`);
      return 3;
    },
    close: async () => undefined,
  };
}

export function post(path: string, body: unknown): Request {
  return new Request(`http://agent${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
