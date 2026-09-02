import type { QueueOperationsRepository } from '../src/features/queue-operations/application/QueueOperationsRepository';

export function repositoryOf(calls: string[]): QueueOperationsRepository {
  let paused = false;
  return {
    limits: async (queue, maxJobs) => {
      calls.push(`limits:${queue}:${maxJobs}`);
      return {
        rateLimit: { max: 12, duration: 1000 },
        concurrency: 5,
        rateLimitTtl: 0,
        maxed: false,
      };
    },
    group: async (queue, groupId, maxJobs, maxCount, start, end) => {
      calls.push(`group:${queue}:${groupId}:${maxJobs}:${maxCount}:${start}:${end}`);
      return {
        jobs: 2,
        active: 1,
        totalGrouped: 4,
        paused,
        entries: [{ id: 'group-job-1', name: 'deliver', priority: 2, delay: 0, timestamp: 100 }],
        priorityCounts: { '2': 1 },
        rateLimit: { max: 5, duration: 1000 },
        rateLimitTtl: 25,
        concurrency: 3,
      };
    },
    pauseGroup: async (queue, groupId) => {
      calls.push(`group-pause:${queue}:${groupId}`);
      const changed = !paused;
      paused = true;
      return changed;
    },
    resumeGroup: async (queue, groupId) => {
      calls.push(`group-resume:${queue}:${groupId}`);
      const changed = paused;
      paused = false;
      return changed;
    },
    setGroupRateLimit: async (queue, groupId, max, duration) => {
      calls.push(`group-rate:${queue}:${groupId}:${max}:${duration}`);
    },
    removeGroupRateLimit: async (queue, groupId) => {
      calls.push(`group-rate-remove:${queue}:${groupId}`);
      return 1;
    },
    setGroupConcurrency: async (queue, groupId, concurrency) => {
      calls.push(`group-concurrency:${queue}:${groupId}:${concurrency}`);
    },
    removeGroupConcurrency: async (queue, groupId) => {
      calls.push(`group-concurrency-remove:${queue}:${groupId}`);
      return 1;
    },
    deduplicationJobId: async (queue, id) => {
      calls.push(`dedup:${queue}:${id}`);
      return 'job-42';
    },
    removeDeduplicationKey: async (queue, id) => {
      calls.push(`remove:${queue}:${id}`);
      return 1;
    },
    metrics: async (queue, type, start, end) => {
      calls.push(`metrics:${queue}:${type}:${start}:${end}`);
      return { meta: { count: 9, prevTS: 100, prevCount: 2 }, data: [2, 1, 0], count: 3 };
    },
    trimEvents: async (queue, maxLength) => {
      calls.push(`trim:${queue}:${maxLength}`);
      return 3;
    },
  };
}
