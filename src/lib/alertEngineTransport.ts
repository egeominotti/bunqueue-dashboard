import { normalizeBaseUrl } from '@/components/dashboard/stores/connectionStore';
import type { bq } from './bq';

export type AlertSummaryRow = Awaited<ReturnType<typeof bq.queuesSummary>>[number];
export type AlertQueueRow = Awaited<ReturnType<typeof bq.queues>>['queues'][number];
export type AlertOverview = Awaited<ReturnType<typeof bq.overview>>;
export type AlertQueuePage = Awaited<ReturnType<typeof bq.queues>>;

export interface AlertQueueClient {
  queues: (limit?: number, offset?: number) => Promise<AlertQueuePage>;
}

export interface AlertTickClient extends AlertQueueClient {
  queuesSummary: () => Promise<unknown>;
  overview: () => Promise<unknown>;
}

export interface AlertServerTarget {
  readonly baseUrl: string;
  readonly authorization?: string;
}

const ALERT_REQUEST_TIMEOUT_MS = 30_000;

/** Stable identity for alert metrics (the control-agent token is not used here). */
export const alertConnectionIdentity = (baseUrl: string, token: string): string =>
  JSON.stringify([baseUrl, token]);

/** Resolve one render identity into an immutable URL and bearer target. */
export function alertServerTarget(connectionIdentity: string): AlertServerTarget {
  const value = JSON.parse(connectionIdentity) as unknown;
  if (!Array.isArray(value) || value.length !== 2) {
    throw new TypeError('Invalid alert connection identity.');
  }
  const [rawBaseUrl, rawToken] = value;
  const baseUrl = normalizeBaseUrl(rawBaseUrl);
  if (!baseUrl || typeof rawToken !== 'string') {
    throw new TypeError('Invalid alert server target.');
  }
  const token = rawToken.trim();
  return Object.freeze({ baseUrl, ...(token ? { authorization: `Bearer ${token}` } : {}) });
}

/** Metrics client pinned to one URL, bearer, and effect lifecycle. */
export function createAlertTickClient(
  target: AlertServerTarget,
  lifecycleSignal: AbortSignal
): AlertTickClient {
  const headers = new Headers({ Accept: 'application/json' });
  if (target.authorization) headers.set('Authorization', target.authorization);

  const request = async (path: string): Promise<unknown> => {
    lifecycleSignal.throwIfAborted();
    const signal = AbortSignal.any([
      lifecycleSignal,
      AbortSignal.timeout(ALERT_REQUEST_TIMEOUT_MS),
    ]);
    const response = await fetch(target.baseUrl + path, { headers, signal });
    lifecycleSignal.throwIfAborted();
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 401 && typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent('auth:required', {
            detail: {
              scope: 'server',
              auth: target.authorization,
              target: target.baseUrl,
            },
          })
        );
      }
      throw new Error(`Alert metrics request failed: HTTP ${response.status}`);
    }
    const text = await response.text();
    lifecycleSignal.throwIfAborted();
    if (!text) throw new Error('Alert metrics request returned an empty response.');
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`Alert metrics request returned invalid JSON (HTTP ${response.status}).`);
    }
  };

  return Object.freeze({
    queuesSummary: () => request('/queues/summary'),
    queues: (limit = 500, offset = 0) =>
      request(`/dashboard/queues?limit=${limit}&offset=${offset}`) as Promise<AlertQueuePage>,
    overview: () => request('/dashboard'),
  });
}
