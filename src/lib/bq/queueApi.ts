import type { DlqConfig, DlqEntryFull, DlqStatsFull, StallConfig } from '../bqTypes';
import { queueHttpPathSegment } from '../upstreamPaths';
import { BULK_TIMEOUT_MS, body, bulkBody, srv } from './transport';

export const queueApi = {
  counts: (queue: string) =>
    srv<{ ok: boolean; counts: Record<string, number> }>(
      `/queues/${queueHttpPathSegment(queue)}/counts`
    ),
  pause: (queue: string) => srv(`/queues/${queueHttpPathSegment(queue)}/pause`, body('POST')),
  resume: (queue: string) => srv(`/queues/${queueHttpPathSegment(queue)}/resume`, body('POST')),
  drain: (queue: string) =>
    srv<{ ok: boolean; count: number }>(
      `/queues/${queueHttpPathSegment(queue)}/drain`,
      bulkBody('POST'),
      true,
      [],
      BULK_TIMEOUT_MS
    ),
  obliterate: (queue: string) =>
    srv(
      `/queues/${queueHttpPathSegment(queue)}/obliterate`,
      bulkBody('POST'),
      true,
      [],
      BULK_TIMEOUT_MS
    ),
  clean: (queue: string, options: { grace?: number; state?: string; limit?: number } = {}) =>
    srv<{ ok: boolean; count: number }>(
      `/queues/${queueHttpPathSegment(queue)}/clean`,
      body('POST', options)
    ),
  promoteJobs: (queue: string, count?: number) =>
    srv<{ ok: boolean; count: number }>(
      `/queues/${queueHttpPathSegment(queue)}/promote-jobs`,
      body('POST', count == null ? undefined : { count })
    ),
  retryCompleted: (_queue: string, _id?: string): never => {
    throw new TypeError(
      'Completed-job requeue is unavailable in Bunqueue v2.9.2 because flow dependency registration is not rebuilt.'
    );
  },
  setRateLimit: (queue: string, limit: number, duration?: number, ttl?: number) =>
    srv(
      `/queues/${queueHttpPathSegment(queue)}/rate-limit`,
      body('PUT', {
        limit,
        ...(duration === undefined ? {} : { duration }),
        ...(ttl === undefined ? {} : { ttl }),
      })
    ),
  clearRateLimit: (queue: string) =>
    srv(`/queues/${queueHttpPathSegment(queue)}/rate-limit`, { method: 'DELETE' }),
  setConcurrency: (queue: string, concurrency: number) =>
    srv(`/queues/${queueHttpPathSegment(queue)}/concurrency`, body('PUT', { concurrency })),
  clearConcurrency: (queue: string) =>
    srv(`/queues/${queueHttpPathSegment(queue)}/concurrency`, { method: 'DELETE' }),
  getStallConfig: (queue: string) =>
    srv<{ ok: boolean; config: StallConfig }>(
      `/queues/${queueHttpPathSegment(queue)}/stall-config`
    ),
  setStallConfig: (queue: string, config: Partial<StallConfig>) =>
    srv(`/queues/${queueHttpPathSegment(queue)}/stall-config`, body('PUT', { config })),
  getDlqConfig: (queue: string) =>
    srv<{ ok: boolean; config: DlqConfig }>(`/queues/${queueHttpPathSegment(queue)}/dlq-config`),
  setDlqConfig: (queue: string, config: Partial<DlqConfig>) => {
    if (config.autoRetry === true) {
      throw new TypeError(
        'DLQ auto-retry is unavailable: Bunqueue v2.9.2 does not rebuild flow dependency registration.'
      );
    }
    if (config.maxAge !== undefined || config.maxEntries !== undefined) {
      throw new TypeError(
        'DLQ retention is read-only: maxAge/maxEntries can destructively expire or evict flow jobs without an atomic dependency check.'
      );
    }
    return srv(`/queues/${queueHttpPathSegment(queue)}/dlq-config`, body('PUT', { config }));
  },
  dlq: (queue: string, limit = 100, offset = 0) =>
    srv<{ ok: boolean; entries: DlqEntryFull[]; total: number }>(
      `/queues/${queueHttpPathSegment(queue)}/dlq?limit=${limit}&offset=${offset}`
    ),
  dlqStats: (queue: string) =>
    srv<{ ok: boolean; stats: DlqStatsFull }>(`/queues/${queueHttpPathSegment(queue)}/dlq/stats`),
  retryDlq: (_queue: string, _jobId?: string): never => {
    throw new TypeError(
      'DLQ retry is unavailable in Bunqueue v2.9.2 because the endpoint has no atomic job-generation, state, or flow-topology precondition.'
    );
  },
  purgeDlq: (queue: string) =>
    srv<{ ok: boolean; count: number }>(
      `/queues/${queueHttpPathSegment(queue)}/dlq/purge`,
      body('POST')
    ),
};
