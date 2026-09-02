import { getBaseUrl } from '@/components/dashboard/stores/connectionStore';
import type { JobFull, QueueSummaryFull, StorageStatusFlat } from '../bqTypes';
import { parseQueueSummaryPayload } from '../dashboardPayloads';
import type {
  OverviewResponse,
  QueueDetailResponse,
  QueuesResponse,
  StatsResponse,
} from '../types';
import {
  decodedHttpPathSegment,
  opaqueHttpPathSegment,
  queueHttpPathSegment,
} from '../upstreamPaths';
import { assertBulkJobCount, encodedAddJobRequest, encodedBulkJobRequest } from './jobPayload';
import { BULK_TIMEOUT_MS, body, srv } from './transport';
import type { AddJobBody, BulkJobBody, HeapMB } from './types';

export const serverInfoApi = {
  overview: (init?: RequestInit) => srv<OverviewResponse>('/dashboard', init),
  queues: (limit = 500, offset = 0) =>
    srv<QueuesResponse>(`/dashboard/queues?limit=${limit}&offset=${offset}`),
  queuesSummary: async () =>
    parseQueueSummaryPayload(await srv<unknown>('/queues/summary')) as QueueSummaryFull[],
  queueDetail: (queue: string, includeJobs = true) =>
    srv<QueueDetailResponse>(
      `/dashboard/queues/${queueHttpPathSegment(queue)}?includeJobs=${includeJobs}`
    ),
  stats: (init?: RequestInit) => srv<StatsResponse>('/stats', init),
  storage: () => srv<{ ok: boolean; data: StorageStatusFlat }>('/storage', undefined, false),
  health: () =>
    srv<{ ok?: boolean; version?: string } & Record<string, unknown>>(
      '/health',
      undefined,
      false,
      [503]
    ),
  ping: () => srv<{ ok: boolean; data: { pong: boolean; time: number } }>('/ping'),
  prometheusUrl: () => `${getBaseUrl()}/prometheus`,
  gc: () => srv<{ ok: boolean; before: HeapMB; after: HeapMB }>('/gc', body('POST')),
  heapStats: () =>
    srv<{
      ok: boolean;
      memory: HeapMB;
      heap: { objectCount: number; protectedCount: number; globalCount: number };
      collections: Record<string, unknown>;
      topObjectTypes: { type: string; count: number }[];
    }>('/heapstats'),
};

export const jobsApi = {
  jobsList: (queue: string, states?: string[], limit = 50, offset = 0) => {
    const search = new URLSearchParams();
    if (states?.length) search.set('states', states.join(','));
    search.set('limit', String(limit));
    search.set('offset', String(offset));
    return srv<{ ok: boolean; jobs: JobFull[] }>(
      `/queues/${queueHttpPathSegment(queue)}/jobs/list?${search}`
    );
  },
  job: (id: string) => srv<{ ok: boolean; job: JobFull }>(`/jobs/${opaqueHttpPathSegment(id)}`),
  jobByCustomId: (customId: string) =>
    srv<{ ok: boolean; job: JobFull }>(
      `/jobs/custom/${decodedHttpPathSegment(customId, 'Custom job ID')}`
    ),
  jobResult: (id: string) =>
    srv<{ ok: boolean; result: unknown }>(`/jobs/${opaqueHttpPathSegment(id)}/result`),
  jobLogs: (id: string) =>
    srv<{ ok: boolean; data: { logs: unknown[]; count: number } }>(
      `/jobs/${opaqueHttpPathSegment(id)}/logs`
    ),
  jobChildren: (id: string) =>
    srv<{ ok: boolean; data: { values: unknown } }>(`/jobs/${opaqueHttpPathSegment(id)}/children`),
  addJob: async (queue: string, job: AddJobBody) =>
    srv<{ ok: boolean; id: string }>(`/queues/${queueHttpPathSegment(queue)}/jobs`, {
      method: 'POST',
      body: encodedAddJobRequest(job),
    }),
  addJobsBulk: async (queue: string, jobs: BulkJobBody[]) => {
    assertBulkJobCount(jobs);
    return srv<{ ok: boolean; ids: string[] }>(
      `/queues/${queueHttpPathSegment(queue)}/jobs/bulk`,
      { method: 'POST', body: encodedBulkJobRequest(jobs) },
      true,
      [],
      BULK_TIMEOUT_MS
    );
  },
  pullBatch: (queue: string, count: number, owner?: string) =>
    srv<{ ok: boolean; jobs: { id: string }[]; tokens?: string[] }>(
      `/queues/${queueHttpPathSegment(queue)}/jobs/pull-batch`,
      body('POST', { count, ...(owner ? { owner } : {}) })
    ),
  ackBatch: (ids: string[], tokens?: string[]) =>
    srv<{ ok: boolean }>('/jobs/ack-batch', body('POST', { ids, ...(tokens ? { tokens } : {}) })),
  cancelJob: (id: string) => srv(`/jobs/${opaqueHttpPathSegment(id)}`, { method: 'DELETE' }),
  promoteJob: (id: string) => srv(`/jobs/${opaqueHttpPathSegment(id)}/promote`, body('POST')),
  discardJob: (id: string) => srv(`/jobs/${opaqueHttpPathSegment(id)}/discard`, body('POST')),
  retryJob: (id: string) => srv(`/jobs/${opaqueHttpPathSegment(id)}/move-to-wait`, body('POST')),
  failJob: (
    id: string,
    error?: string,
    options: { unrecoverable?: boolean; stack?: string[] } = {}
  ) => srv(`/jobs/${opaqueHttpPathSegment(id)}/fail`, body('POST', { error, ...options })),
  updateJobData: (id: string, data: unknown) =>
    srv(`/jobs/${opaqueHttpPathSegment(id)}/data`, body('PUT', { data })),
  changePriority: (id: string, priority: number, lifo?: boolean) =>
    srv(
      `/jobs/${opaqueHttpPathSegment(id)}/priority`,
      body('PUT', { priority, ...(lifo === undefined ? {} : { lifo }) })
    ),
  changeDelay: (id: string, delay: number) =>
    srv(`/jobs/${opaqueHttpPathSegment(id)}/delay`, body('PUT', { delay })),
  moveToDelayed: (id: string, delay: number) =>
    srv(`/jobs/${opaqueHttpPathSegment(id)}/move-to-delayed`, body('POST', { delay })),
  addJobLog: (id: string, message: string, level?: 'info' | 'warn' | 'error') =>
    srv(`/jobs/${opaqueHttpPathSegment(id)}/logs`, body('POST', { message, level })),
  clearJobLogs: (id: string) =>
    srv(`/jobs/${opaqueHttpPathSegment(id)}/logs`, { method: 'DELETE' }),
  setJobProgress: (id: string, progress: number, message?: string) =>
    srv(`/jobs/${opaqueHttpPathSegment(id)}/progress`, body('POST', { progress, message })),
};
