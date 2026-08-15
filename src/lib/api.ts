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
  MetricsResponse,
  OverviewResponse,
  QueueDetailResponse,
  QueuesResponse,
  ReadinessResponse,
  StatsResponse,
  StorageStatus,
} from './types';
import {
  decodedHttpPathSegment,
  eventQueuePathSegment,
  opaqueHttpPathSegment,
  queueHttpPathSegment,
} from './upstreamPaths';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Per-request deadline — fetch has no default timeout, so a reachable-but-hung
 * server would leave the promise pending forever and stall every poll loop that
 * awaits it. Overridable in tests. A caller signal is composed with, rather
 * than substituted for, this deadline.
 */
let requestTimeoutMs = 30_000;
export function setRequestTimeoutMs(ms: number): void {
  requestTimeoutMs = ms;
}

async function request<T>(
  path: string,
  init?: RequestInit,
  strict = true,
  acceptedStatuses: readonly number[] = [],
  responseFormat: 'json' | 'text' = 'json'
): Promise<T> {
  const deadline = AbortSignal.timeout(requestTimeoutMs);
  const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  const requestHeaders = new Headers(getAuthHeaders());
  if (init?.headers) {
    new Headers(init.headers).forEach((value, name) => {
      requestHeaders.set(name, value);
    });
  }
  // Avoid forcing a CORS preflight on read-only requests. JSON is only the
  // default when a body is actually present, and an explicit caller value wins.
  if (init?.body != null && !requestHeaders.has('Content-Type')) {
    requestHeaders.set('Content-Type', 'application/json');
  }
  let res: Response;
  try {
    res = await fetch(getBaseUrl() + path, {
      ...init,
      headers: requestHeaders,
      signal,
    });
  } catch (e) {
    // A blown deadline surfaces as the normal error type (status 0 — no response).
    if (
      (deadline.aborted && !init?.signal?.aborted) ||
      (e as { name?: string } | null)?.name === 'TimeoutError'
    ) {
      throw new ApiError('Request timed out', 0);
    }
    throw e;
  }

  if (!res.ok && !acceptedStatuses.includes(res.status)) {
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
  // Defensive parse (mirrors bq.call()): a 2xx with an empty or non-JSON body —
  // an SPA-fallback proxy answering `/api/health` with index.html, a 200 with no
  // body — must surface as an ApiError carrying the status, not a raw SyntaxError.
  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    if (deadline.aborted && !init?.signal?.aborted) {
      throw new ApiError('Request timed out', 0);
    }
    throw e;
  }
  if (!text) return undefined as T;
  if (responseFormat === 'text') return text as T;
  let data: T;
  try {
    data = JSON.parse(text) as T;
  } catch {
    throw new ApiError(`Invalid JSON response (HTTP ${res.status})`, res.status);
  }
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

const q = queueHttpPathSegment;
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
  // Disk-full is a diagnostic state, not a transport failure: bunqueue v2.8.59
  // returns its structured health payload with HTTP 503 in that state.
  health: () => request<Record<string, unknown>>('/health', undefined, false, [503]),
  // Bunqueue 2.8.59 exposes both unauthenticated liveness aliases as plain
  // text. Keep their raw response so callers can distinguish the exact "OK"
  // contract from a reverse-proxy fallback page that merely returned HTTP 200.
  healthz: () => request<string>('/healthz', undefined, true, [], 'text'),
  live: () => request<string>('/live', undefined, true, [], 'text'),
  // A persistence failure is a valid readiness result carried by HTTP 503.
  ready: () => request<ReadinessResponse>('/ready', undefined, false, [503]),
  metrics: () => request<MetricsResponse>('/metrics'),

  // ---- Jobs ----
  jobsList: (queue: string, params: JobsListParams = {}) => {
    const sp = new URLSearchParams();
    if (params.states?.length) sp.set('states', params.states.join(','));
    sp.set('limit', String(params.limit ?? 50));
    sp.set('offset', String(params.offset ?? 0));
    return request<{ ok: boolean; jobs: Job[] }>(`/queues/${q(queue)}/jobs/list?${sp.toString()}`);
  },
  job: (id: string) => request<{ ok: boolean; job: Job }>(`/jobs/${opaqueHttpPathSegment(id)}`),
  cancelJob: (id: string) => del(`/jobs/${opaqueHttpPathSegment(id)}`),
  promoteJob: (id: string) => post(`/jobs/${opaqueHttpPathSegment(id)}/promote`),
  retryJob: (id: string) => post(`/jobs/${opaqueHttpPathSegment(id)}/move-to-wait`),

  // ---- Queue control ----
  pause: (queue: string) => post(`/queues/${q(queue)}/pause`),
  resume: (queue: string) => post(`/queues/${q(queue)}/resume`),
  drain: (queue: string) => post(`/queues/${q(queue)}/drain`),
  obliterate: (queue: string) => post(`/queues/${q(queue)}/obliterate`),
  clean: (queue: string, grace = 0, limit = 1000) =>
    post(`/queues/${q(queue)}/clean`, { grace, limit }),
  retryCompleted: (_queue: string): never => {
    throw new TypeError(
      'Completed-job requeue is unavailable in Bunqueue v2.8.59 because flow dependency registration is not rebuilt.'
    );
  },

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
  dlqStats: (queue: string) =>
    request<{ ok: boolean; stats: DlqStats }>(`/queues/${q(queue)}/dlq/stats`),
  retryDlq: (_queue: string): never => {
    throw new TypeError(
      'DLQ retry is unavailable in Bunqueue v2.8.59 because the endpoint has no atomic flow-safety precondition.'
    );
  },
  purgeDlq: (queue: string) => post(`/queues/${q(queue)}/dlq/purge`),

  // ---- Resources ----
  crons: () => request<{ ok: boolean; crons: unknown[] }>('/crons'),
  deleteCron: (name: string) => del(`/crons/${decodedHttpPathSegment(name, 'Cron name', 256)}`),
  workers: () => request<{ ok: boolean; workers: unknown[] }>('/workers'),

  /** Absolute URL of the SSE activity stream. */
  eventsUrl: (queue?: string) =>
    getBaseUrl() + (queue ? `/events/queues/${eventQueuePathSegment(queue)}` : '/events'),
};
