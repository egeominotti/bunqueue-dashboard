import {
  getAgentAuthHeaders,
  getAuthHeaders,
  getBaseUrl,
  normalizeBaseUrl,
} from '@/components/dashboard/stores/connectionStore';
import type { JobFull } from '../bqTypes';
import { opaqueHttpPathSegment } from '../upstreamPaths';

export class BqError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'BqError';
  }
}

let requestTimeoutMs = 30_000;
export const getRequestTimeoutMs = () => requestTimeoutMs;
export function setRequestTimeoutMs(ms: number): void {
  requestTimeoutMs = ms;
}

export async function call<T>(
  base: string,
  path: string,
  headers: Record<string, string>,
  init?: RequestInit,
  strict = true,
  authScope: 'server' | 'agent' = 'server',
  acceptedStatuses: readonly number[] = [],
  timeoutMs = requestTimeoutMs
): Promise<T> {
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  const requestHeaders = new Headers(headers);
  if (init?.headers) {
    new Headers(init.headers).forEach((value, name) => {
      requestHeaders.set(name, value);
    });
  }
  if (init?.body != null && !requestHeaders.has('Content-Type')) {
    requestHeaders.set('Content-Type', 'application/json');
  }

  let response: Response;
  try {
    response = await fetch(base + path, { ...init, headers: requestHeaders, signal });
  } catch (error) {
    if (
      (deadline.aborted && !init?.signal?.aborted) ||
      (error as { name?: string } | null)?.name === 'TimeoutError'
    ) {
      throw new BqError('Request timed out', 0);
    }
    throw error;
  }

  if (!response.ok && !acceptedStatuses.includes(response.status)) {
    let message = `HTTP ${response.status}`;
    try {
      const errorBody = (await response.json()) as { error?: string };
      if (errorBody?.error) message = errorBody.error;
    } catch {
      // Preserve the HTTP status for non-JSON errors.
    }
    if (response.status === 401 && typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('auth:required', {
          detail: {
            scope: authScope,
            auth: requestHeaders.get('Authorization') ?? undefined,
            target: base,
          },
        })
      );
    }
    throw new BqError(message, response.status);
  }
  if (response.status === 204) return undefined as T;

  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    if (deadline.aborted && !init?.signal?.aborted) throw new BqError('Request timed out', 0);
    throw error;
  }
  if (!text) return undefined as T;
  let data: T;
  try {
    data = JSON.parse(text) as T;
  } catch {
    throw new BqError(`Invalid JSON response (HTTP ${response.status})`, response.status);
  }
  if (strict && data && typeof data === 'object' && (data as { ok?: unknown }).ok === false) {
    throw new BqError((data as { error?: string }).error ?? 'Operation failed', response.status);
  }
  return data;
}

export const srv = <T>(
  path: string,
  init?: RequestInit,
  strict = true,
  acceptedStatuses: readonly number[] = [],
  timeoutMs = requestTimeoutMs
): Promise<T> =>
  call<T>(
    getBaseUrl(),
    path,
    getAuthHeaders(),
    init,
    strict,
    'server',
    acceptedStatuses,
    timeoutMs
  );

export const SAFE_AGENT_BASE = 'http://localhost:6800';
export function resolveAgentBase(runtimeValue: unknown, envValue: unknown): string {
  return normalizeBaseUrl(runtimeValue) ?? normalizeBaseUrl(envValue) ?? SAFE_AGENT_BASE;
}

function runtimeAgentBase(): unknown {
  try {
    return (globalThis as { __BUNQUEUE_AGENT_URL__?: unknown }).__BUNQUEUE_AGENT_URL__;
  } catch {
    return undefined;
  }
}

const AGENT = resolveAgentBase(runtimeAgentBase(), import.meta.env.VITE_BUNQUEUE_AGENT_URL);
export const getAgentBase = () => AGENT;
export const agentRequest = <T>(
  path: string,
  init?: RequestInit,
  timeoutMs = requestTimeoutMs
): Promise<T> => call<T>(AGENT, path, getAgentAuthHeaders(), init, true, 'agent', [], timeoutMs);

export const body = (method: string, value?: unknown): RequestInit => ({
  method,
  body: value === undefined ? undefined : JSON.stringify(value),
});
export const BULK_TIMEOUT_MS = 300_000;
export const bulkBody = (method: string, value?: unknown): RequestInit => body(method, value);

export interface ServerRequestTarget {
  readonly baseUrl: string;
}

export interface AgentRequestTarget {
  readonly baseUrl: string;
}

const serverHeaders = new WeakMap<ServerRequestTarget, Readonly<Record<string, string>>>();
const agentHeaders = new WeakMap<AgentRequestTarget, Readonly<Record<string, string>>>();

export function captureServerRequestTarget(): ServerRequestTarget {
  const target = Object.freeze({ baseUrl: getBaseUrl() });
  serverHeaders.set(target, Object.freeze({ ...getAuthHeaders() }));
  return target;
}

export function captureAgentRequestTarget(): AgentRequestTarget {
  const target = Object.freeze({ baseUrl: AGENT });
  agentHeaders.set(target, Object.freeze({ ...getAgentAuthHeaders() }));
  return target;
}

export function serverHeadersFor(target: ServerRequestTarget): Readonly<Record<string, string>> {
  const headers = serverHeaders.get(target);
  if (!headers) throw new TypeError('Invalid server request target.');
  return headers;
}

export function agentHeadersFor(target: AgentRequestTarget): Readonly<Record<string, string>> {
  const headers = agentHeaders.get(target);
  if (!headers) throw new TypeError('Invalid agent request target.');
  return headers;
}

function sameHeaders(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>
) {
  const entries = Object.entries(left);
  return (
    entries.length === Object.keys(right).length &&
    entries.every(([key, value]) => right[key] === value)
  );
}

export function assertCurrentServerRequestTarget(target: ServerRequestTarget): void {
  const captured = serverHeadersFor(target);
  if (target.baseUrl !== getBaseUrl() || !sameHeaders(captured, getAuthHeaders())) {
    throw new Error(
      `Server connection changed after confirmation was requested for ${target.baseUrl}; action refused.`
    );
  }
}

export async function getJobAtTarget(
  target: ServerRequestTarget,
  id: string,
  signal?: AbortSignal
): Promise<{ ok: boolean; job: JobFull }> {
  signal?.throwIfAborted();
  const result = await call<{ ok: boolean; job: JobFull }>(
    target.baseUrl,
    `/jobs/${opaqueHttpPathSegment(id)}`,
    { ...serverHeadersFor(target) },
    signal ? { signal } : undefined
  );
  signal?.throwIfAborted();
  return result;
}
