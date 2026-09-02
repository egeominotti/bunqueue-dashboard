import type { OverviewResponse, QueueSummary, QueuesResponse } from '../../src/lib/types';

export function classicOverview(
  overrides: Partial<Pick<OverviewResponse, 'storage' | 'workers'>> = {}
): OverviewResponse {
  return {
    ok: true,
    stats: {
      waiting: 12,
      active: 3,
      delayed: 4,
      completed: 1_234,
      dlq: 2,
      totalPushed: 2_000,
      totalPulled: 1_900,
      totalCompleted: 1_850,
      totalFailed: 50,
      uptime: 3_723_000,
    },
    throughput: { pushPerSec: 7.5, pullPerSec: 6.25, completePerSec: 5.5, failPerSec: 0.25 },
    latency: {
      averages: { pushMs: 1.25, pullMs: 2.5 },
      percentiles: { push: { p50: 1, p95: 9.5, p99: 18 } },
    },
    memory: { heapUsed: 64, heapTotal: 128, rss: 256 },
    collections: { jobs: 1_900, queues: 21 },
    workers: overrides.workers ?? {
      total: 2,
      active: 1,
      truncated: false,
      list: [
        {
          id: 'worker-a',
          name: 'mailer',
          queues: ['emails'],
          lastSeen: Date.now() - 2_000,
          activeJobs: 1,
          processedJobs: 90,
          failedJobs: 2,
        },
        {
          id: 'worker-b',
          name: '',
          queues: [],
          lastSeen: Date.now() - 5_000,
          activeJobs: 0,
          processedJobs: 8,
          failedJobs: 0,
        },
      ],
    },
    crons: { total: 3, list: [], truncated: false },
    storage: overrides.storage ?? { diskFull: false, error: null, since: null },
    timestamp: Date.now(),
  };
}

export function classicQueue(index: number): QueueSummary {
  return {
    name: index === 20 ? 'omega-final' : `queue-${String(index).padStart(2, '0')}`,
    waiting: index,
    active: index % 3,
    delayed: index % 2,
    dlq: index === 1 ? 2 : 0,
    paused: index === 1,
  };
}

export function classicQueues(offset = 0, limit = 20): QueuesResponse {
  const all = Array.from({ length: 21 }, (_, index) => classicQueue(index));
  return {
    ok: true,
    queues: all.slice(offset, offset + limit),
    total: all.length,
    limit,
    offset,
    timestamp: Date.now(),
  };
}
