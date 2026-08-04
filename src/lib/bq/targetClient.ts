import type { CronFull, DlqEntryFull, DlqStatsFull, JobFull, QueueSummaryFull } from '../bqTypes';
import { parseQueueSummaryPayload, parseWorkersPayload } from '../dashboardPayloads';
import type { OverviewResponse, StatsResponse } from '../types';
import { opaqueHttpPathSegment, queueHttpPathSegment } from '../upstreamPaths';
import { assertBulkJobCount, encodedBulkJobRequest } from './jobPayload';
import {
  BqError,
  BULK_TIMEOUT_MS,
  body,
  call,
  getRequestTimeoutMs,
  type ServerRequestTarget,
  serverHeadersFor,
} from './transport';
import type { BulkJobBody } from './types';

export interface ServerTargetClient {
  queuesSummary: () => Promise<QueueSummaryFull[]>;
  overview: () => Promise<OverviewResponse>;
  counts: (queue: string) => Promise<{ ok: boolean; counts: Record<string, number> }>;
  jobsList: (
    queue: string,
    states?: string[],
    limit?: number,
    offset?: number
  ) => Promise<{ ok: true; jobs: JobFull[] }>;
  job: (id: string) => Promise<{ ok: true; job: JobFull }>;
  dlqStats: (queue: string) => Promise<{ ok: true; stats: DlqStatsFull }>;
  dlq: (
    queue: string,
    limit?: number,
    offset?: number
  ) => Promise<{ ok: true; entries: DlqEntryFull[]; total: number }>;
  health: () => Promise<{ ok?: boolean; version?: string } & Record<string, unknown>>;
  stats: () => Promise<StatsResponse>;
  workers: () => Promise<ReturnType<typeof parseWorkersPayload>>;
  crons: () => Promise<{ ok: true; crons: CronFull[] }>;
  addJobsBulk: (queue: string, jobs: BulkJobBody[]) => Promise<{ ok: boolean; ids: string[] }>;
  pullBatch: (queue: string, count: number) => Promise<{ ok: boolean; jobs: { id: string }[] }>;
  heartbeatBatch: (ids: string[]) => Promise<{ ok: boolean; data: { ok: boolean; count: number } }>;
  ackBatch: (ids: string[]) => Promise<{ ok: boolean }>;
  retryJob: (id: string) => Promise<unknown>;
  promoteJob: (id: string) => Promise<undefined | { ok: true }>;
  pause: (queue: string) => Promise<undefined | { ok: true }>;
  resume: (queue: string) => Promise<undefined | { ok: true }>;
  clean: (
    queue: string,
    options?: { grace?: number; state?: string; limit?: number }
  ) => Promise<{ ok: boolean; count: number }>;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BqError(`Malformed ${label} response.`, 200);
  }
  return value as Record<string, unknown>;
}

function okRecord(value: unknown, label: string): Record<string, unknown> {
  const result = record(value, label);
  if (result.ok !== true) throw new BqError(`Malformed ${label} response.`, 200);
  return result;
}

const validCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function mutationAck(value: unknown, label: string): undefined | { ok: true } {
  if (value === undefined) return;
  return okRecord(value, label) as unknown as { ok: true };
}

export function createServerTargetClient(
  target: ServerRequestTarget,
  lifecycleSignal?: AbortSignal
): ServerTargetClient {
  const headers = { ...serverHeadersFor(target) };
  const at = <T>(
    path: string,
    init?: RequestInit,
    timeoutMs = getRequestTimeoutMs()
  ): Promise<T> => {
    const requestInit = lifecycleSignal
      ? {
          ...init,
          signal: init?.signal ? AbortSignal.any([init.signal, lifecycleSignal]) : lifecycleSignal,
        }
      : init;
    return call<T>(target.baseUrl, path, headers, requestInit, true, 'server', [], timeoutMs);
  };

  return Object.freeze({
    queuesSummary: async () => parseQueueSummaryPayload(await at<unknown>('/queues/summary')),
    overview: () => at<OverviewResponse>('/dashboard'),
    counts: async (queue: string) => {
      const result = okRecord(
        await at<unknown>(`/queues/${queueHttpPathSegment(queue)}/counts`),
        'queue counts'
      );
      const counts = record(result.counts, 'queue counts');
      if (!Object.values(counts).every(validCount))
        throw new BqError('Malformed queue counts response.', 200);
      return { ok: true, counts: counts as Record<string, number> };
    },
    jobsList: async (queue: string, states?: string[], limit = 50, offset = 0) => {
      const search = new URLSearchParams();
      if (states?.length) search.set('states', states.join(','));
      search.set('limit', String(limit));
      search.set('offset', String(offset));
      const result = okRecord(
        await at<unknown>(`/queues/${queueHttpPathSegment(queue)}/jobs/list?${search}`),
        'jobs list'
      );
      if (
        !Array.isArray(result.jobs) ||
        !result.jobs.every((candidate) => {
          const job = candidate as Partial<JobFull> | null;
          return (
            job !== null &&
            typeof job === 'object' &&
            !Array.isArray(job) &&
            typeof job.id === 'string' &&
            job.id.length > 0 &&
            (job.queue === undefined || job.queue === queue)
          );
        })
      )
        throw new BqError('Malformed jobs list response.', 200);
      return { ok: true as const, jobs: result.jobs as JobFull[] };
    },
    job: async (id: string) => {
      const result = okRecord(await at<unknown>(`/jobs/${opaqueHttpPathSegment(id)}`), 'job');
      const job = record(result.job, 'job') as unknown as JobFull;
      if (job.id !== id) throw new BqError('Malformed job response.', 200);
      return { ok: true as const, job };
    },
    dlqStats: async (queue: string) => {
      const result = okRecord(
        await at<unknown>(`/queues/${queueHttpPathSegment(queue)}/dlq/stats`),
        'DLQ stats'
      );
      const stats = record(result.stats, 'DLQ stats') as unknown as DlqStatsFull;
      if (!validCount(stats.total)) throw new BqError('Malformed DLQ stats response.', 200);
      return { ok: true as const, stats };
    },
    dlq: async (queue: string, limit = 100, offset = 0) => {
      const result = okRecord(
        await at<unknown>(
          `/queues/${queueHttpPathSegment(queue)}/dlq?limit=${limit}&offset=${offset}`
        ),
        'DLQ list'
      );
      if (!Array.isArray(result.entries) || !validCount(result.total))
        throw new BqError('Malformed DLQ list response.', 200);
      for (const entry of result.entries) {
        const job = record(record(entry, 'DLQ list').job, 'DLQ list');
        if (typeof job.id !== 'string' || !job.id)
          throw new BqError('Malformed DLQ list response.', 200);
      }
      return { ok: true as const, entries: result.entries as DlqEntryFull[], total: result.total };
    },
    health: async () =>
      record(
        await call<unknown>(
          target.baseUrl,
          '/health',
          headers,
          lifecycleSignal ? { signal: lifecycleSignal } : undefined,
          false,
          'server',
          [503]
        ),
        'health'
      ) as { ok?: boolean; version?: string } & Record<string, unknown>,
    stats: async () => {
      const raw = await at<unknown>('/stats');
      record(okRecord(raw, 'server stats').stats, 'server stats');
      return raw as StatsResponse;
    },
    workers: async () => parseWorkersPayload(await at<unknown>('/workers')),
    crons: async () => {
      const result = okRecord(await at<unknown>('/crons'), 'crons');
      if (
        !Array.isArray(result.crons) ||
        !result.crons.every((candidate) => {
          const cron = candidate as Partial<CronFull> | null;
          return (
            cron !== null &&
            typeof cron === 'object' &&
            !Array.isArray(cron) &&
            typeof cron.name === 'string' &&
            !!cron.name &&
            typeof cron.queue === 'string' &&
            !!cron.queue
          );
        })
      )
        throw new BqError('Malformed crons response.', 200);
      return { ok: true as const, crons: result.crons as CronFull[] };
    },
    addJobsBulk: async (queue: string, jobs: BulkJobBody[]) => {
      assertBulkJobCount(jobs);
      return at<{ ok: boolean; ids: string[] }>(
        `/queues/${queueHttpPathSegment(queue)}/jobs/bulk`,
        { method: 'POST', body: encodedBulkJobRequest(jobs) },
        BULK_TIMEOUT_MS
      );
    },
    pullBatch: (queue: string, count: number) =>
      at<{ ok: boolean; jobs: { id: string }[] }>(
        `/queues/${queueHttpPathSegment(queue)}/jobs/pull-batch`,
        body('POST', { count })
      ),
    heartbeatBatch: (ids: string[]) =>
      at<{ ok: boolean; data: { ok: boolean; count: number } }>(
        '/jobs/heartbeat-batch',
        body('POST', { ids })
      ),
    ackBatch: (ids: string[]) => at<{ ok: boolean }>('/jobs/ack-batch', body('POST', { ids })),
    retryJob: (id: string) => at(`/jobs/${opaqueHttpPathSegment(id)}/move-to-wait`, body('POST')),
    promoteJob: async (id: string) =>
      mutationAck(
        await at(`/jobs/${opaqueHttpPathSegment(id)}/promote`, body('POST')),
        'promote job'
      ),
    pause: async (queue: string) =>
      mutationAck(
        await at(`/queues/${queueHttpPathSegment(queue)}/pause`, body('POST')),
        'pause queue'
      ),
    resume: async (queue: string) =>
      mutationAck(
        await at(`/queues/${queueHttpPathSegment(queue)}/resume`, body('POST')),
        'resume queue'
      ),
    clean: (queue: string, options = {}) =>
      at<{ ok: boolean; count: number }>(
        `/queues/${queueHttpPathSegment(queue)}/clean`,
        body('POST', options)
      ),
  });
}
