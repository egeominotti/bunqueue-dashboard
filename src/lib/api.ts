/**
 * Typed client for the bunqueue HTTP API.
 * Every call reads the current base URL + token from the connection store, so
 * changing the connection in Settings takes effect immediately.
 */
import { getAuthHeaders, getBaseUrl } from '@/components/dashboard/stores/connectionStore';
import type {
  DlqEntry,
  DlqStats,
  Job,
  OverviewResponse,
  QueueDetailResponse,
  QueuesResponse,
  StatsResponse,
  StorageStatus,
} from './types';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit, strict = true): Promise<T> {
  const res = await fetch(getBaseUrl() + path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...getAuthHeaders(),
      ...init?.headers,
    },
  });

  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(message, res.status);
  }

  if (res.status === 204) return undefined as T;
  const data = (await res.json()) as T;
  // Many mutating endpoints return HTTP 200 with { ok:false, error } on logical
  // failure (cancel a finished job, apply a rate limit, …). Surface those as
  // errors instead of resolving as success. `strict:false` opts out where `ok`
  // is a semantic status flag rather than a success flag (storage/health).
  if (strict && data && typeof data === 'object' && (data as { ok?: unknown }).ok === false) {
    const err = (data as { error?: string }).error;
    throw new ApiError(err ?? 'Operation failed', res.status);
  }
  return data;
}

const q = (s: string) => encodeURIComponent(s);
const post = (path: string, body?: unknown): Promise<unknown> =>
  request(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
const put = (path: string, body?: unknown): Promise<unknown> =>
  request(path, { method: 'PUT', body: body ? JSON.stringify(body) : undefined });
const del = (path: string): Promise<unknown> => request(path, { method: 'DELETE' });

export interface JobsListParams {
  states?: string[];
  limit?: number;
  offset?: number;
}

export const api = {
  // ---- Aggregated dashboard endpoints ----
  overview: () => request<OverviewResponse>('/dashboard'),
  queues: (limit = 200, offset = 0) =>
    request<QueuesResponse>(`/dashboard/queues?limit=${limit}&offset=${offset}`),
  queueDetail: (queue: string, includeJobs = true) =>
    request<QueueDetailResponse>(`/dashboard/queues/${q(queue)}?includeJobs=${includeJobs}`),

  // ---- Diagnostics ----
  stats: () => request<StatsResponse>('/stats'),
  // strict:false — `ok` here is a semantic status flag (disk-full → ok:false at
  // HTTP 200 is data, not a request failure), so it must not throw.
  storage: () => request<{ ok: boolean; data: StorageStatus }>('/storage', undefined, false),
  health: () => request<Record<string, unknown>>('/health', undefined, false),

  // ---- Jobs ----
  jobsList: (queue: string, params: JobsListParams = {}) => {
    const sp = new URLSearchParams();
    if (params.states?.length) sp.set('states', params.states.join(','));
    sp.set('limit', String(params.limit ?? 50));
    sp.set('offset', String(params.offset ?? 0));
    return request<{ ok: boolean; jobs: Job[] }>(`/queues/${q(queue)}/jobs/list?${sp.toString()}`);
  },
  job: (id: string) => request<{ ok: boolean; job: Job }>(`/jobs/${q(id)}`),
  cancelJob: (id: string) => del(`/jobs/${q(id)}`),
  promoteJob: (id: string) => post(`/jobs/${q(id)}/promote`),
  retryJob: (id: string) => post(`/jobs/${q(id)}/move-to-wait`),

  // ---- Queue control ----
  pause: (queue: string) => post(`/queues/${q(queue)}/pause`),
  resume: (queue: string) => post(`/queues/${q(queue)}/resume`),
  drain: (queue: string) => post(`/queues/${q(queue)}/drain`),
  obliterate: (queue: string) => post(`/queues/${q(queue)}/obliterate`),
  clean: (queue: string, grace = 0, limit = 1000) =>
    post(`/queues/${q(queue)}/clean`, { grace, limit }),
  retryCompleted: (queue: string) => post(`/queues/${q(queue)}/retry-completed`),

  // ---- Rate limit / concurrency ----
  setRateLimit: (queue: string, max: number) =>
    put(`/queues/${q(queue)}/rate-limit`, { limit: max }),
  clearRateLimit: (queue: string) => del(`/queues/${q(queue)}/rate-limit`),
  setConcurrency: (queue: string, concurrency: number) =>
    put(`/queues/${q(queue)}/concurrency`, { concurrency }),
  clearConcurrency: (queue: string) => del(`/queues/${q(queue)}/concurrency`),

  // ---- DLQ ----
  dlq: (queue: string, limit = 50, offset = 0) =>
    request<{ ok: boolean; entries: DlqEntry[]; total?: number }>(
      `/queues/${q(queue)}/dlq?limit=${limit}&offset=${offset}`
    ),
  dlqStats: (queue: string) => request<DlqStats>(`/queues/${q(queue)}/dlq/stats`),
  retryDlq: (queue: string) => post(`/queues/${q(queue)}/dlq/retry`),
  purgeDlq: (queue: string) => post(`/queues/${q(queue)}/dlq/purge`),

  // ---- Resources ----
  crons: () => request<{ ok: boolean; crons: unknown[] }>('/crons'),
  deleteCron: (name: string) => del(`/crons/${q(name)}`),
  workers: () => request<{ ok: boolean; workers: unknown[] }>('/workers'),

  /** Absolute URL of the SSE activity stream. */
  eventsUrl: (queue?: string) => getBaseUrl() + (queue ? `/events/queues/${q(queue)}` : '/events'),
};
