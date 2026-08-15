import { getBaseUrl, useConnectionStore } from '@/components/dashboard/stores/connectionStore';
import { BqError } from '@/lib/bq';
import type { JobFull } from '@/lib/bqTypes';
import { decodedHttpPathSegment, opaqueHttpPathSegment } from '@/lib/upstreamPaths';
import { jobFromEnvelope } from './jobValidation';
import type { JobLookupOptions, JobLookupTarget, LookupMode } from './types';

const JOB_LOOKUP_TIMEOUT_MS = 30_000;

export function currentJobLookupTarget(): JobLookupTarget {
  const { token } = useConnectionStore.getState();
  return {
    // Keep the same defense-in-depth canonicalization as every shared API
    // client, including against direct Zustand injection of a legacy //host.
    baseUrl: getBaseUrl(),
    authorization: token ? `Bearer ${token}` : undefined,
  };
}

export function sameJobLookupTarget(a: JobLookupTarget | null, b: JobLookupTarget): boolean {
  return a?.baseUrl === b.baseUrl && a.authorization === b.authorization;
}

function mapLookupRequestError(
  error: unknown,
  deadline: AbortSignal,
  lifecycleSignal?: AbortSignal
): unknown {
  if (deadline.aborted && !lifecycleSignal?.aborted) {
    return new BqError('Request timed out', 0);
  }
  return error;
}

/** GET transport scoped to one immutable server/auth snapshot. */
export async function lookupGet<T>(
  target: JobLookupTarget,
  path: string,
  lifecycleSignal?: AbortSignal,
  timeoutMs = JOB_LOOKUP_TIMEOUT_MS
): Promise<T | undefined> {
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = lifecycleSignal ? AbortSignal.any([lifecycleSignal, deadline]) : deadline;

  const headers = new Headers();
  if (target.authorization) headers.set('Authorization', target.authorization);

  let response: Response;
  try {
    signal.throwIfAborted();
    response = await fetch(`${target.baseUrl}${path}`, { headers, signal });
    // Test doubles are allowed to ignore AbortSignal. Never parse or continue a
    // lifecycle that was cancelled while their promise was pending.
    signal.throwIfAborted();
  } catch (error) {
    throw mapLookupRequestError(error, deadline, lifecycleSignal);
  }

  if (response.status === 204) return undefined;

  let text: string;
  try {
    text = await response.text();
    signal.throwIfAborted();
  } catch (error) {
    throw mapLookupRequestError(error, deadline, lifecycleSignal);
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
    const message = typeof serverMessage === 'string' ? serverMessage : `HTTP ${response.status}`;
    if (response.status === 401 && typeof window !== 'undefined') {
      window.dispatchEvent(
        new window.CustomEvent('auth:required', {
          detail: {
            scope: 'server',
            auth: target.authorization,
            target: target.baseUrl,
          },
        })
      );
    }
    throw new BqError(message, response.status);
  }

  if (!text) return undefined;
  if (invalidJson) {
    throw new BqError(`Invalid JSON response (HTTP ${response.status})`, response.status);
  }
  if (data && typeof data === 'object' && (data as { ok?: unknown }).ok === false) {
    const serverMessage = (data as { error?: unknown }).error;
    throw new BqError(
      typeof serverMessage === 'string' ? serverMessage : 'Operation failed',
      response.status
    );
  }
  return data as T;
}

/**
 * The v2.8.59 custom-id route returns the stored snapshot without resolving its
 * live state, unlike GET /jobs/:id. Resolve the internal id through the normal
 * endpoint so every inspector panel receives one authoritative JobFull.
 */
export async function loadJobForLookup(
  key: string,
  mode: LookupMode,
  options: JobLookupOptions = {}
): Promise<JobFull | null> {
  // Capture once; never read the connection store between custom-id resolution
  // and its canonical internal-id fetch.
  const target = options.target ?? currentJobLookupTarget();
  const timeoutMs = options.timeoutMs ?? JOB_LOOKUP_TIMEOUT_MS;
  const initial = await lookupGet<unknown>(
    target,
    mode === 'custom'
      ? `/jobs/custom/${decodedHttpPathSegment(key, 'Custom job ID')}`
      : `/jobs/${opaqueHttpPathSegment(key)}`,
    options.signal,
    timeoutMs
  );
  const candidate = jobFromEnvelope(initial, {
    canonical: mode === 'id',
    expectedId: mode === 'id' ? key : undefined,
  });
  if (!candidate || mode === 'id') return candidate;
  // Correlate the index snapshot to the requested key before trusting its id.
  if (candidate.customId !== key) {
    throw new BqError(`Invalid job response: expected job.customId ${JSON.stringify(key)}`, 200);
  }
  const resolved = await lookupGet<unknown>(
    target,
    `/jobs/${opaqueHttpPathSegment(candidate.id)}`,
    options.signal,
    timeoutMs
  );
  return jobFromEnvelope(resolved, { canonical: true, expectedId: candidate.id });
}
