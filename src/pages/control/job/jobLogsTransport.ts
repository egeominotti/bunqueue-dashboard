import { getBaseUrl, useConnectionStore } from '@/components/dashboard/stores/connectionStore';
import { BqError } from '@/lib/bq';

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogTarget {
  baseUrl: string;
  authorization?: string;
}

const LOG_REQUEST_TIMEOUT_MS = 30_000;

export function currentLogTarget(): LogTarget {
  const { token } = useConnectionStore.getState();
  return {
    baseUrl: getBaseUrl(),
    authorization: token ? `Bearer ${token}` : undefined,
  };
}

export function sameLogTarget(left: LogTarget, right: LogTarget): boolean {
  return left.baseUrl === right.baseUrl && left.authorization === right.authorization;
}

function mapRequestError(
  error: unknown,
  deadline: AbortSignal,
  lifecycleSignal: AbortSignal
): unknown {
  if (deadline.aborted && !lifecycleSignal.aborted) return new BqError('Request timed out', 0);
  return error;
}

export async function logRequest<T>(
  target: LogTarget,
  path: string,
  init: RequestInit,
  lifecycleSignal: AbortSignal
): Promise<T | undefined> {
  const deadline = AbortSignal.timeout(LOG_REQUEST_TIMEOUT_MS);
  const signal = AbortSignal.any([lifecycleSignal, deadline]);
  const headers = new Headers(init.headers);
  if (target.authorization) headers.set('Authorization', target.authorization);
  if (init.body != null && !headers.has('Content-Type'))
    headers.set('Content-Type', 'application/json');

  let response: Response;
  try {
    signal.throwIfAborted();
    response = await fetch(`${target.baseUrl}${path}`, { ...init, headers, signal });
    signal.throwIfAborted();
  } catch (error) {
    throw mapRequestError(error, deadline, lifecycleSignal);
  }
  if (response.status === 204) return undefined;

  let text: string;
  try {
    text = await response.text();
    signal.throwIfAborted();
  } catch (error) {
    throw mapRequestError(error, deadline, lifecycleSignal);
  }

  let data: unknown;
  let invalidJson = false;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      invalidJson = true;
    }
  }
  if (!response.ok) {
    const serverMessage =
      !invalidJson && data && typeof data === 'object'
        ? (data as { error?: unknown }).error
        : undefined;
    if (response.status === 401 && typeof window !== 'undefined') {
      window.dispatchEvent(
        new window.CustomEvent('auth:required', {
          detail: { scope: 'server', auth: target.authorization, target: target.baseUrl },
        })
      );
    }
    throw new BqError(
      typeof serverMessage === 'string' ? serverMessage : `HTTP ${response.status}`,
      response.status
    );
  }
  if (!text) return undefined;
  if (invalidJson)
    throw new BqError(`Invalid JSON response (HTTP ${response.status})`, response.status);
  if (data && typeof data === 'object' && (data as { ok?: unknown }).ok === false) {
    const serverMessage = (data as { error?: unknown }).error;
    throw new BqError(
      typeof serverMessage === 'string' ? serverMessage : 'Operation failed',
      response.status
    );
  }
  return data as T;
}

export function parseLogSnapshot(value: unknown): { logs: unknown[]; count: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BqError('Invalid logs response: expected an object envelope', 200);
  }
  const envelope = value as { ok?: unknown; data?: unknown };
  if (envelope.ok !== true || !envelope.data || typeof envelope.data !== 'object') {
    throw new BqError('Invalid logs response: expected { ok: true, data }', 200);
  }
  const data = envelope.data as { logs?: unknown; count?: unknown };
  if (
    !Array.isArray(data.logs) ||
    typeof data.count !== 'number' ||
    !Number.isSafeInteger(data.count) ||
    data.count < 0
  ) {
    throw new BqError('Invalid logs response: expected logs[] and a non-negative count', 200);
  }
  return { logs: data.logs, count: data.count };
}
