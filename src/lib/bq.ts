/**
 * Full-control bunqueue client — the complete, verified surface used by the
 * control pages. Additive: it does not modify the original lib/api.ts.
 *
 * Reads base URL + token from the connection store; talks to the control agent
 * (process lifecycle) at VITE_BUNQUEUE_AGENT_URL (default http://localhost:6800).
 */
import { getAuthHeaders, getBaseUrl } from '@/components/dashboard/stores/connectionStore';
import type {
  CronFull,
  DlqConfig,
  DlqEntryFull,
  DlqStatsFull,
  JobFull,
  QueueSummaryFull,
  ServerConfig,
  ServerLogLine,
  ServerStatus,
  StallConfig,
  StorageStatusFlat,
  WebhookFull,
  WorkerFull,
} from './bqTypes';
import type { OverviewResponse, QueueDetailResponse, QueuesResponse, StatsResponse } from './types';

export class BqError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'BqError';
  }
}

async function call<T>(
  base: string,
  path: string,
  headers: Record<string, string>,
  init?: RequestInit,
  strict = true
): Promise<T> {
  const res = await fetch(base + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...headers, ...init?.headers },
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      /* non-JSON */
    }
    throw new BqError(message, res.status);
  }
  if (res.status === 204) return undefined as T;
  const data = (await res.json()) as T;
  // Many mutating endpoints return HTTP 200 with { ok:false, error } on logical
  // failure (cancel a finished job, purge unknown queue, …). Surface those as
  // errors instead of resolving as success. `strict:false` opts out for the rare
  // endpoint where `ok` is a semantic status flag rather than a success flag —
  // GET /health sets `ok: isHealthy` (disk-full → ok:false, HTTP 200, not an error).
  if (strict && data && typeof data === 'object' && (data as { ok?: unknown }).ok === false) {
    const err = (data as { error?: string }).error;
    throw new BqError(err ?? 'Operation failed', res.status);
  }
  return data;
}

const srv = <T>(path: string, init?: RequestInit, strict = true): Promise<T> =>
  call<T>(getBaseUrl(), path, getAuthHeaders(), init, strict);

const AGENT = (import.meta.env.VITE_BUNQUEUE_AGENT_URL || 'http://localhost:6800').replace(
  /\/$/,
  ''
);
const agent = <T>(path: string, init?: RequestInit): Promise<T> => call<T>(AGENT, path, {}, init);

const q = (s: string) => encodeURIComponent(s);
const body = (method: string, b?: unknown): RequestInit => ({
  method,
  body: b === undefined ? undefined : JSON.stringify(b),
});

export interface AddJobBody {
  data: unknown;
  priority?: number;
  delay?: number;
  maxAttempts?: number;
  backoff?: number;
  timeout?: number;
  jobId?: string;
  removeOnComplete?: boolean;
  removeOnFail?: boolean;
  durable?: boolean;
  ttl?: number;
  uniqueKey?: string;
  lifo?: boolean;
}

export interface CreateCronBody {
  name: string;
  queue: string;
  data?: unknown;
  schedule?: string;
  repeatEvery?: number;
  priority?: number;
  timezone?: string;
  skipIfNoWorker?: boolean;
  preventOverlap?: boolean;
}

export interface AddWebhookBody {
  url: string;
  events: string[];
  queue?: string;
  secret?: string;
}

export const WEBHOOK_EVENTS = [
  'job.pushed',
  'job.started',
  'job.completed',
  'job.failed',
  'job.progress',
] as const;

export const bq = {
  // ---- Read ----
  overview: () => srv<OverviewResponse>('/dashboard'),
  queues: (limit = 500, offset = 0) =>
    srv<QueuesResponse>(`/dashboard/queues?limit=${limit}&offset=${offset}`),
  // All queues' counts (waiting/active/completed/failed/delayed + paused) in a
  // single call — replaces per-queue queueDetail fan-outs. Bare array, O(Q)
  // server-side; for very large deployments prefer paginated `queues()`.
  queuesSummary: () => srv<QueueSummaryFull[]>('/queues/summary'),
  queueDetail: (queue: string, includeJobs = true) =>
    srv<QueueDetailResponse>(`/dashboard/queues/${q(queue)}?includeJobs=${includeJobs}`),
  stats: () => srv<StatsResponse>('/stats'),
  storage: () => srv<{ ok: boolean; data: StorageStatusFlat }>('/storage'),
  // strict:false — /health's `ok` means "server healthy", not "request succeeded"
  // (disk-full reports ok:false with HTTP 200; that's data, not an error to throw).
  health: () =>
    srv<{ ok?: boolean; version?: string } & Record<string, unknown>>('/health', undefined, false),
  ping: () => srv<{ ok: boolean; data: { pong: boolean; time: number } }>('/ping'),

  // ---- Jobs (read) ----
  jobsList: (queue: string, states?: string[], limit = 50, offset = 0) => {
    const sp = new URLSearchParams();
    if (states?.length) sp.set('states', states.join(','));
    sp.set('limit', String(limit));
    sp.set('offset', String(offset));
    return srv<{ ok: boolean; jobs: JobFull[] }>(`/queues/${q(queue)}/jobs/list?${sp}`);
  },
  job: (id: string) => srv<{ ok: boolean; job: JobFull }>(`/jobs/${q(id)}`),
  jobByCustomId: (customId: string) =>
    srv<{ ok: boolean; job: JobFull }>(`/jobs/custom/${q(customId)}`),
  jobResult: (id: string) => srv<{ ok: boolean; result: unknown }>(`/jobs/${q(id)}/result`),
  jobLogs: (id: string) =>
    srv<{ ok: boolean; data: { logs: unknown[]; count: number } }>(`/jobs/${q(id)}/logs`),
  jobChildren: (id: string) =>
    srv<{ ok: boolean; data: { values: unknown } }>(`/jobs/${q(id)}/children`),

  // ---- Jobs (write) ----
  addJob: (queue: string, b: AddJobBody) =>
    srv<{ ok: boolean; id: string }>(`/queues/${q(queue)}/jobs`, body('POST', b)),
  addJobsBulk: (queue: string, jobs: AddJobBody[]) =>
    srv<{ ok: boolean; ids: string[] }>(`/queues/${q(queue)}/jobs/bulk`, body('POST', { jobs })),
  // Worker-side consume: reserve up to `count` jobs, then ack (complete) them by
  // id. Used by the Benchmark page to simulate workers draining a queue.
  pullBatch: (queue: string, count: number) =>
    srv<{ ok: boolean; jobs: { id: string }[] }>(
      `/queues/${q(queue)}/jobs/pull-batch`,
      body('POST', { count })
    ),
  ackBatch: (ids: string[]) => srv<{ ok: boolean }>('/jobs/ack-batch', body('POST', { ids })),
  cancelJob: (id: string) => srv(`/jobs/${q(id)}`, { method: 'DELETE' }),
  promoteJob: (id: string) => srv(`/jobs/${q(id)}/promote`, body('POST')),
  discardJob: (id: string) => srv(`/jobs/${q(id)}/discard`, body('POST')),
  retryJob: (id: string) => srv(`/jobs/${q(id)}/move-to-wait`, body('POST')),
  failJob: (id: string, error?: string) => srv(`/jobs/${q(id)}/fail`, body('POST', { error })),
  updateJobData: (id: string, data: unknown) => srv(`/jobs/${q(id)}/data`, body('PUT', { data })),
  changePriority: (id: string, priority: number) =>
    srv(`/jobs/${q(id)}/priority`, body('PUT', { priority })),
  changeDelay: (id: string, delay: number) => srv(`/jobs/${q(id)}/delay`, body('PUT', { delay })),
  moveToDelayed: (id: string, delay: number) =>
    srv(`/jobs/${q(id)}/move-to-delayed`, body('POST', { delay })),
  addJobLog: (id: string, message: string, level?: 'info' | 'warn' | 'error') =>
    srv(`/jobs/${q(id)}/logs`, body('POST', { message, level })),
  clearJobLogs: (id: string) => srv(`/jobs/${q(id)}/logs`, { method: 'DELETE' }),

  // ---- Queue control ----
  counts: (queue: string) =>
    srv<{ ok: boolean; counts: Record<string, number> }>(`/queues/${q(queue)}/counts`),
  pause: (queue: string) => srv(`/queues/${q(queue)}/pause`, body('POST')),
  resume: (queue: string) => srv(`/queues/${q(queue)}/resume`, body('POST')),
  drain: (queue: string) =>
    srv<{ ok: boolean; count: number }>(`/queues/${q(queue)}/drain`, body('POST')),
  obliterate: (queue: string) => srv(`/queues/${q(queue)}/obliterate`, body('POST')),
  clean: (queue: string, opts: { grace?: number; state?: string; limit?: number } = {}) =>
    srv<{ ok: boolean; count: number }>(`/queues/${q(queue)}/clean`, body('POST', opts)),
  promoteJobs: (queue: string, count?: number) =>
    srv<{ ok: boolean; count: number }>(
      `/queues/${q(queue)}/promote-jobs`,
      body('POST', count != null ? { count } : undefined)
    ),
  retryCompleted: (queue: string, id?: string) =>
    srv<{ ok: boolean; count: number }>(
      `/queues/${q(queue)}/retry-completed`,
      body('POST', id ? { id } : undefined)
    ),

  // ---- Limits / config ----
  setRateLimit: (queue: string, limit: number) =>
    srv(`/queues/${q(queue)}/rate-limit`, body('PUT', { limit })),
  clearRateLimit: (queue: string) => srv(`/queues/${q(queue)}/rate-limit`, { method: 'DELETE' }),
  setConcurrency: (queue: string, concurrency: number) =>
    srv(`/queues/${q(queue)}/concurrency`, body('PUT', { concurrency })),
  clearConcurrency: (queue: string) => srv(`/queues/${q(queue)}/concurrency`, { method: 'DELETE' }),
  getStallConfig: (queue: string) =>
    srv<{ ok: boolean; config: StallConfig }>(`/queues/${q(queue)}/stall-config`),
  setStallConfig: (queue: string, config: Partial<StallConfig>) =>
    srv(`/queues/${q(queue)}/stall-config`, body('PUT', { config })),
  getDlqConfig: (queue: string) =>
    srv<{ ok: boolean; config: DlqConfig }>(`/queues/${q(queue)}/dlq-config`),
  setDlqConfig: (queue: string, config: Partial<DlqConfig>) =>
    srv(`/queues/${q(queue)}/dlq-config`, body('PUT', { config })),

  // ---- DLQ ----
  dlq: (queue: string, limit = 100, offset = 0) =>
    srv<{ ok: boolean; entries: DlqEntryFull[]; total: number }>(
      `/queues/${q(queue)}/dlq?limit=${limit}&offset=${offset}`
    ),
  dlqStats: (queue: string) =>
    srv<{ ok: boolean; stats: DlqStatsFull }>(`/queues/${q(queue)}/dlq/stats`),
  retryDlq: (queue: string, jobId?: string) =>
    srv<{ ok: boolean; count: number }>(
      `/queues/${q(queue)}/dlq/retry`,
      body('POST', jobId ? { jobId } : undefined)
    ),
  purgeDlq: (queue: string) =>
    srv<{ ok: boolean; count: number }>(`/queues/${q(queue)}/dlq/purge`, body('POST')),

  // ---- Crons ----
  crons: () => srv<{ ok: boolean; crons: CronFull[] }>('/crons'),
  createCron: (b: CreateCronBody) => srv('/crons', body('POST', b)),
  deleteCron: (name: string) => srv(`/crons/${q(name)}`, { method: 'DELETE' }),

  // ---- Webhooks ----
  webhooks: () =>
    srv<{ ok: boolean; data: { webhooks: WebhookFull[]; stats?: unknown } }>('/webhooks'),
  addWebhook: (b: AddWebhookBody) => srv('/webhooks', body('POST', b)),
  removeWebhook: (id: string) => srv(`/webhooks/${q(id)}`, { method: 'DELETE' }),
  setWebhookEnabled: (id: string, enabled: boolean) =>
    srv(`/webhooks/${q(id)}/enabled`, body('PUT', { enabled })),

  // ---- Workers ----
  workers: () => srv<{ ok: boolean; data: { workers: WorkerFull[]; stats?: unknown } }>('/workers'),
  unregisterWorker: (id: string) => srv(`/workers/${q(id)}`, { method: 'DELETE' }),

  eventsUrl: (queue?: string) => getBaseUrl() + (queue ? `/events/queues/${q(queue)}` : '/events'),

  // ---- Control agent (process lifecycle) ----
  agentBase: AGENT,
  control: {
    status: () => agent<ServerStatus>('/control/status'),
    start: () => agent<ServerStatus>('/control/start', { method: 'POST' }),
    stop: () => agent<ServerStatus>('/control/stop', { method: 'POST' }),
    restart: () => agent<ServerStatus>('/control/restart', { method: 'POST' }),
    logs: () => agent<{ lines: ServerLogLine[] }>('/control/logs'),
    getConfig: () => agent<ServerConfig>('/control/config'),
    setConfig: (config: Partial<ServerConfig>) =>
      agent<ServerConfig>('/control/config', body('PUT', config)),
  },
};
