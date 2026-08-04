import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { getBaseUrl, useConnectionStore } from '@/components/dashboard/stores/connectionStore';
import { Button, IconButton } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { CopyButton } from '@/components/ui/CopyButton';
import { EmptyState, LoadingState } from '@/components/ui/feedback';
import { Select } from '@/components/ui/form';
import { IconDownload, IconSearch } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { BqError, bq } from '@/lib/bq';
import type { JobFull } from '@/lib/bqTypes';
import { buildCloneState } from '@/lib/cloneJob';
import { downloadJson } from '@/lib/exportFile';
import { formatDateTime, formatDuration } from '@/lib/format';
import { decodedHttpPathSegment, opaqueHttpPathSegment } from '@/lib/upstreamPaths';
import { JobActionsPanel } from './job/JobActionsPanel';
import { JobBackoff } from './job/JobBackoff';
import { JobChildren } from './job/JobChildren';
import { JobDataEditor, jobDataReadOnlyReason } from './job/JobDataEditor';
import { JobLogs } from './job/JobLogs';
import { JobTimeline } from './job/JobTimeline';

export type LookupMode = 'id' | 'custom';

export interface JobLookupTarget {
  baseUrl: string;
  authorization?: string;
}

export interface JobLookupOptions {
  signal?: AbortSignal;
  target?: JobLookupTarget;
  /** Test seam; production retains the same 30s deadline as the shared client. */
  timeoutMs?: number;
}

const JOB_LOOKUP_TIMEOUT_MS = 30_000;

function currentJobLookupTarget(): JobLookupTarget {
  const { token } = useConnectionStore.getState();
  return {
    // Keep the same defense-in-depth canonicalization as every shared API
    // client, including against direct Zustand injection of a legacy //host.
    baseUrl: getBaseUrl(),
    authorization: token ? `Bearer ${token}` : undefined,
  };
}

function sameJobLookupTarget(a: JobLookupTarget | null, b: JobLookupTarget): boolean {
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
async function lookupGet<T>(
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

function invalidJobEnvelope(reason: string): never {
  throw new BqError(`Invalid job response: ${reason}`, 200);
}

function validateOptionalString(
  job: Record<string, unknown>,
  field: string,
  { nullable = false, nonEmpty = false }: { nullable?: boolean; nonEmpty?: boolean } = {},
  path = 'job'
): void {
  if (!Object.hasOwn(job, field) || job[field] === undefined) return;
  const value = job[field];
  if (nullable && value === null) return;
  if (typeof value !== 'string' || (nonEmpty && !value.trim())) {
    invalidJobEnvelope(
      `${path}.${field} must be ${nullable ? 'a string or null' : 'a string'}${nonEmpty ? ' (non-empty)' : ''}`
    );
  }
}

function validateOptionalNumber(
  job: Record<string, unknown>,
  field: string,
  {
    nullable = false,
    integer = false,
    min,
    max,
  }: { nullable?: boolean; integer?: boolean; min?: number; max?: number } = {},
  path = 'job'
): void {
  if (!Object.hasOwn(job, field) || job[field] === undefined) return;
  const value = job[field];
  if (nullable && value === null) return;
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    (integer && !Number.isSafeInteger(value)) ||
    (min !== undefined && value < min) ||
    (max !== undefined && value > max)
  ) {
    invalidJobEnvelope(
      `${path}.${field} must be a valid${integer ? ' safe integer' : ' finite number'}`
    );
  }
}

function validateOptionalBoolean(job: Record<string, unknown>, field: string): void {
  if (Object.hasOwn(job, field) && job[field] !== undefined && typeof job[field] !== 'boolean') {
    invalidJobEnvelope(`job.${field} must be a boolean`);
  }
}

function validateStringArray(
  job: Record<string, unknown>,
  field: string,
  { nullable = false, nonEmpty = false }: { nullable?: boolean; nonEmpty?: boolean } = {}
): void {
  if (!Object.hasOwn(job, field) || job[field] === undefined) return;
  const value = job[field];
  if (nullable && value === null) return;
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== 'string' || (nonEmpty && !entry.trim()))
  ) {
    invalidJobEnvelope(
      `job.${field} must be ${nullable ? 'a string array or null' : 'a string array'}`
    );
  }
}

const MAX_UPSTREAM_STACKTRACE_LINES = 10_000;
const STACKTRACE_PREVIEW_LINES = 100;
const STACKTRACE_PREVIEW_CODE_POINTS = 256 * 1024;

export interface StacktracePreview {
  text: string;
  displayedLines: number;
  totalLines: number;
  truncated: boolean;
}

function codePointPrefix(text: string, maximum: number): { text: string; count: number } {
  let end = 0;
  let count = 0;
  while (end < text.length && count < maximum) {
    const point = text.codePointAt(end);
    end += point !== undefined && point > 0xffff ? 2 : 1;
    count += 1;
  }
  return { text: text.slice(0, end), count };
}

/** Keep a valid large upstream stack inspectable without building a huge DOM text node. */
export function buildStacktracePreview(lines: readonly string[]): StacktracePreview {
  const displayed: string[] = [];
  let usedCharacters = 0;
  let truncated = false;
  const lineLimit = Math.min(lines.length, STACKTRACE_PREVIEW_LINES);

  for (let index = 0; index < lineLimit; index++) {
    const separatorCharacters = displayed.length > 0 ? 1 : 0;
    const remaining = STACKTRACE_PREVIEW_CODE_POINTS - usedCharacters - separatorCharacters;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const line = lines[index] ?? '';
    const visible = codePointPrefix(line, remaining);
    displayed.push(visible.text);
    usedCharacters += separatorCharacters + visible.count;
    if (visible.text.length !== line.length) {
      truncated = true;
      break;
    }
  }

  if (displayed.length < lines.length) truncated = true;
  return {
    text: displayed.join('\n'),
    displayedLines: displayed.length,
    totalLines: lines.length,
    truncated,
  };
}

/** Validate every structured value consumed by this page or its child panels. */
function validateRenderableJob(job: Record<string, unknown>, canonical: boolean): void {
  if (canonical && (typeof job.state !== 'string' || !job.state.trim())) {
    invalidJobEnvelope('canonical job.state must be a non-empty string');
  }
  validateOptionalString(job, 'state', { nonEmpty: true });
  validateOptionalString(job, 'name', { nonEmpty: true });
  validateOptionalString(job, 'failedReason');
  if (canonical && (typeof job.queue !== 'string' || !job.queue.trim())) {
    invalidJobEnvelope('canonical job.queue must be a non-empty string');
  }
  validateOptionalString(job, 'queue', { nonEmpty: true });
  validateOptionalString(job, 'customId', { nullable: true });
  validateOptionalString(job, 'parentId', { nullable: true, nonEmpty: true });
  validateOptionalString(job, 'groupId', { nullable: true });
  validateOptionalString(job, 'progressMessage', { nullable: true });

  validateStringArray(job, 'childrenIds', { nonEmpty: true });
  validateStringArray(job, 'dependsOn', { nonEmpty: true });
  validateStringArray(job, 'tags');
  validateStringArray(job, 'stacktrace', { nullable: true });
  if (Array.isArray(job.stacktrace) && job.stacktrace.length > MAX_UPSTREAM_STACKTRACE_LINES) {
    invalidJobEnvelope(
      `job.stacktrace exceeds Bunqueue's ${MAX_UPSTREAM_STACKTRACE_LINES}-entry limit`
    );
  }

  validateOptionalNumber(job, 'priority', { integer: true });
  validateOptionalNumber(job, 'createdAt');
  validateOptionalNumber(job, 'runAt');
  validateOptionalNumber(job, 'startedAt', { nullable: true });
  validateOptionalNumber(job, 'completedAt', { nullable: true });
  validateOptionalNumber(job, 'attempts', { integer: true, min: 0 });
  validateOptionalNumber(job, 'maxAttempts', { integer: true, min: 0 });
  validateOptionalNumber(job, 'backoff', { integer: true, min: 0 });
  validateOptionalNumber(job, 'timeout', { nullable: true, integer: true, min: 0 });
  validateOptionalNumber(job, 'ttl', { nullable: true, integer: true, min: 0 });
  validateOptionalNumber(job, 'progress', { min: 0, max: 100 });
  validateOptionalNumber(job, 'lastHeartbeat');
  validateOptionalNumber(job, 'stallCount', { integer: true, min: 0 });
  validateOptionalBoolean(job, 'removeOnComplete');
  validateOptionalBoolean(job, 'removeOnFail');

  if (Object.hasOwn(job, 'backoffConfig') && job.backoffConfig !== undefined) {
    const config = job.backoffConfig;
    if (config !== null) {
      if (!config || typeof config !== 'object' || Array.isArray(config)) {
        invalidJobEnvelope('job.backoffConfig must be an object or null');
      }
      const raw = config as Record<string, unknown>;
      if (raw.type !== 'fixed' && raw.type !== 'exponential') {
        invalidJobEnvelope('job.backoffConfig.type must be fixed or exponential');
      }
      validateOptionalNumber(raw, 'delay', { integer: true, min: 0 }, 'job.backoffConfig');
      if (!Object.hasOwn(raw, 'delay') || raw.delay === undefined) {
        invalidJobEnvelope('job.backoffConfig.delay is required');
      }
      validateOptionalNumber(raw, 'maxDelay', { integer: true, min: 0 }, 'job.backoffConfig');
    }
  }

  if (Object.hasOwn(job, 'timeline') && job.timeline !== undefined) {
    if (!Array.isArray(job.timeline)) invalidJobEnvelope('job.timeline must be an array');
    if (job.timeline.length > 20) invalidJobEnvelope('job.timeline exceeds 20 entries');
    for (const [index, entry] of job.timeline.entries()) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        invalidJobEnvelope(`job.timeline[${index}] must be an object`);
      }
      const raw = entry as Record<string, unknown>;
      if (typeof raw.state !== 'string' || !raw.state.trim()) {
        invalidJobEnvelope(`job.timeline[${index}].state must be a non-empty string`);
      }
      if (typeof raw.timestamp !== 'number' || !Number.isFinite(raw.timestamp)) {
        invalidJobEnvelope(`job.timeline[${index}].timestamp must be a finite number`);
      }
      const entryPath = `job.timeline[${index}]`;
      validateOptionalString(raw, 'worker', {}, entryPath);
      validateOptionalString(raw, 'error', {}, entryPath);
      validateOptionalNumber(raw, 'attempt', { integer: true, min: 0 }, entryPath);
    }
  }
}

function jobFromEnvelope(
  value: unknown,
  { canonical, expectedId }: { canonical: boolean; expectedId?: string }
): JobFull | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalidJobEnvelope('expected an object envelope');
  }
  const envelope = value as { ok?: unknown; job?: unknown };
  if (envelope.ok !== true || !Object.hasOwn(envelope, 'job')) {
    return invalidJobEnvelope('expected { ok: true, job }');
  }
  if (envelope.job === null) return null;
  if (!envelope.job || typeof envelope.job !== 'object' || Array.isArray(envelope.job)) {
    return invalidJobEnvelope('job must be an object or null');
  }

  const rawJob = envelope.job as Record<string, unknown>;
  if (typeof rawJob.id !== 'string' || !rawJob.id.trim()) {
    return invalidJobEnvelope('job.id must be a non-empty string');
  }
  if (expectedId !== undefined && rawJob.id !== expectedId) {
    return invalidJobEnvelope(`expected job.id ${JSON.stringify(expectedId)}`);
  }
  validateRenderableJob(rawJob, canonical);
  return rawJob as JobFull;
}

function resultFromEnvelope(value: unknown, expectedId: string): { result: unknown } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BqError('Invalid job result response: expected an object envelope', 200);
  }
  const envelope = value as { ok?: unknown; id?: unknown; result?: unknown };
  if (envelope.ok !== true || envelope.id !== expectedId) {
    throw new BqError('Invalid job result response: expected { ok: true, id, result? }', 200);
  }
  // Bunqueue omits `result` when its value is undefined. The verified id is
  // therefore the presence marker that distinguishes a valid empty result
  // from an unrelated/malformed HTTP-200 payload.
  return { result: envelope.result };
}

/**
 * The v2.8.57 custom-id route returns the stored snapshot without resolving its
 * live state, unlike GET /jobs/:id. Resolve the internal id through the normal
 * endpoint so every inspector panel receives one authoritative JobFull rather
 * than the header guessing "waiting" while the action rail sees "unknown".
 */
export async function loadJobForLookup(
  key: string,
  mode: LookupMode,
  options: JobLookupOptions = {}
): Promise<JobFull | null> {
  // Capture once. In particular, never read the connection store between a
  // custom-id resolution and its canonical internal-id fetch.
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
  // The custom-id endpoint is only an index resolution step. Correlate the
  // returned snapshot to the requested key before trusting its internal id;
  // otherwise a stale/corrupt index entry could make us inspect another job.
  if (candidate.customId !== key) {
    return invalidJobEnvelope(`expected job.customId ${JSON.stringify(key)}`);
  }
  const resolved = await lookupGet<unknown>(
    target,
    `/jobs/${opaqueHttpPathSegment(candidate.id)}`,
    options.signal,
    timeoutMs
  );
  return jobFromEnvelope(resolved, { canonical: true, expectedId: candidate.id });
}

/** Most recent failure message + which attempt it happened on, from the timeline. */
function lastError(job: JobFull): { message: string; attempt?: number; timestamp?: number } | null {
  const timeline = job.timeline ?? [];
  for (let i = timeline.length - 1; i >= 0; i--) {
    const e = timeline[i];
    if (e.state === 'failed' && e.error) {
      return { message: e.error, attempt: e.attempt, timestamp: e.timestamp };
    }
  }
  if (job.failedReason) return { message: job.failedReason };
  return null;
}

export function JobInspector() {
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const connectionBaseUrl = useConnectionStore((state) => state.baseUrl);
  const connectionToken = useConnectionStore((state) => state.token);
  const initialCustomId = params.get('custom');
  const [idInput, setIdInput] = useState(initialCustomId ?? params.get('id') ?? '');
  const [lookupBy, setLookupBy] = useState<LookupMode>(initialCustomId ? 'custom' : 'id');
  const [job, setJob] = useState<JobFull | null>(null);
  const [result, setResult] = useState<{ fetched: boolean; value: unknown }>({
    fetched: false,
    value: undefined,
  });
  // A failed result fetch is NOT "no result stored" — keep the transport error
  // so the Result card can say so instead of asserting a fact about the data.
  const [resultError, setResultError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // Sequence guard (last-to-start wins): Enter can fire concurrent lookups and
  // without it the slower response would clobber the newer one.
  const lookupGen = useRef(0);
  const lookupAbort = useRef<AbortController | null>(null);
  const lookupIdentity = useRef<{ key: string; mode: LookupMode } | null>(null);
  const jobTarget = useRef<JobLookupTarget | null>(null);
  // Clearing ?id= after an internally handled not-found/cancel must not be
  // mistaken for the user navigating to a blank inspector. Keep that terminal
  // feedback until a later real lookup supplies a new URL key.
  const internalEmptyUrlPending = useRef(false);
  const preservedEmptyLocationKey = useRef<string | null>(null);
  const mounted = useRef(false);
  const actionGen = useRef(0);
  const actionBusy = useRef(false);
  // actionGen invalidates stale UI continuations; this separate owner keeps the
  // mutation mutex held until the request that acquired it actually settles.
  const actionLockOwner = useRef<number | null>(null);

  useEffect(() => {
    mounted.current = true;
    // Zustand subscriptions run synchronously with setState. Abort before a
    // response from the old target can resume and publish into the new target's
    // screen; the reactive selectors above then trigger a clean URL reload.
    const unsubscribe = useConnectionStore.subscribe((next, previous) => {
      if (next.baseUrl === previous.baseUrl && next.token === previous.token) return;
      lookupGen.current += 1;
      lookupAbort.current?.abort();
      lookupAbort.current = null;
      lookupIdentity.current = null;
      actionGen.current += 1;
      actionLockOwner.current = null;
      actionBusy.current = false;
      jobTarget.current = null;
      internalEmptyUrlPending.current = false;
      preservedEmptyLocationKey.current = null;
      setJob(null);
      setResult({ fetched: false, value: undefined });
      setResultError(null);
      setNotFound(false);
      setMsg(null);
      setLoading(false);
      setBusy(false);
    });

    return () => {
      mounted.current = false;
      unsubscribe();
      // Invalidate even when a fetch mock ignores abort: every continuation
      // checks this generation before touching state or search params.
      lookupGen.current += 1;
      lookupAbort.current?.abort();
      lookupAbort.current = null;
      lookupIdentity.current = null;
      actionGen.current += 1;
      actionLockOwner.current = null;
      actionBusy.current = false;
    };
  }, []);

  const lookup = async (
    raw: string,
    mode: LookupMode = lookupBy,
    keepMsg = false,
    actionOwner?: number,
    routeDriven = false
  ) => {
    const key = raw.trim();
    if (!key) return;
    // Operators must not be able to release the mutation mutex by pressing
    // Enter or Look up while a POST/DELETE is still pending. URL navigation is
    // allowed to supersede what is displayed, but the lock remains owned by
    // the original request until its finally block runs.
    if (actionOwner === undefined && actionBusy.current && !routeDriven) return;
    internalEmptyUrlPending.current = false;
    preservedEmptyLocationKey.current = null;
    // A user/URL lookup supersedes an in-flight action continuation. The
    // action-owned read-back passes its generation so it can keep the mutex
    // until that reload settles.
    if (actionOwner === undefined) {
      actionGen.current += 1;
    }
    // A route/user lookup for another identity immediately revokes ownership
    // of the rendered snapshot. If that replacement lookup later returns 5xx,
    // keeping the old job mounted would leave its independent action/log
    // controls operable under the new URL once any old mutation settles.
    // Refreshes of the same identity intentionally retain the current snapshot
    // so transient failures remain useful without ever crossing job ownership.
    const replacesDisplayedJob =
      job !== null && (mode === 'id' ? job.id !== key : job.customId !== key);
    if (replacesDisplayedJob) {
      jobTarget.current = null;
      setJob(null);
      setResult({ fetched: false, value: undefined });
      setResultError(null);
    }
    lookupAbort.current?.abort();
    const controller = new AbortController();
    lookupAbort.current = controller;
    lookupIdentity.current = { key, mode };
    const my = ++lookupGen.current;
    const target = currentJobLookupTarget();
    setLoading(true);
    setNotFound(false);
    // After an action, act() has just set its success message — clearing it here
    // would destroy it before it ever paints.
    if (!keepMsg) setMsg(null);
    try {
      const loaded = await loadJobForLookup(key, mode, {
        signal: controller.signal,
        target,
      });
      // A 200 with no `job` (e.g. a custom id that resolves to nothing) is a
      // not-found, not a crash: without this guard `loaded.state` below throws.
      if (!loaded) {
        if (my !== lookupGen.current) return;
        internalEmptyUrlPending.current = true;
        preservedEmptyLocationKey.current = null;
        setJob(null);
        setResult({ fetched: false, value: undefined });
        setResultError(null);
        setNotFound(true);
        setParams({}, { replace: true });
        return;
      }
      // Bunqueue 2.8.57 embeds terminal values in canonical job reads. Retain
      // the legacy result endpoint fallback for older compatible servers.
      let resultRes: { result: unknown } | null = null;
      let resultErr: string | null = null;
      if (
        my !== lookupGen.current ||
        controller.signal.aborted ||
        !sameJobLookupTarget(target, currentJobLookupTarget())
      )
        return;
      if (loaded.state === 'completed') {
        if (Object.hasOwn(loaded, 'returnvalue')) {
          resultRes = { result: loaded.returnvalue };
        } else
          try {
            const envelope = await lookupGet<unknown>(
              target,
              `/jobs/${opaqueHttpPathSegment(loaded.id)}/result`,
              controller.signal
            );
            resultRes = resultFromEnvelope(envelope, loaded.id);
          } catch (e) {
            if (controller.signal.aborted) throw e;
            // Keep it: rendering "No result stored" for a 502 would be a lie.
            resultErr = (e as Error).message;
          }
      }
      if (
        my !== lookupGen.current ||
        controller.signal.aborted ||
        !sameJobLookupTarget(target, currentJobLookupTarget())
      )
        return;
      jobTarget.current = target;
      setJob(loaded);
      if (mode === 'custom') {
        // The input now holds the canonical internal id. Keep its mode aligned
        // so pressing Enter/Look up again uses /jobs/:id, not /jobs/custom/:id.
        setLookupBy('id');
        setIdInput(loaded.id);
      } else {
        setIdInput(key);
      }
      setParams({ id: loaded.id }, { replace: true });
      setResult(
        resultRes
          ? { fetched: true, value: resultRes.result }
          : { fetched: false, value: undefined }
      );
      setResultError(resultErr);
    } catch (e) {
      if (my !== lookupGen.current || controller.signal.aborted) return;
      // A missing job is a real 404 or an HTTP-200 `{ok:false, error:"...not
      // found..."}` (bq.call throws BqError for both — status 200 for the
      // latter); everything else is a connection/server problem.
      if (e instanceof BqError && (e.status === 404 || /not found/i.test(e.message))) {
        internalEmptyUrlPending.current = true;
        preservedEmptyLocationKey.current = null;
        setJob(null);
        setResult({ fetched: false, value: undefined });
        setResultError(null);
        setNotFound(true);
        // Clear the stale URL param too — otherwise the deep-link effect sees
        // idParam !== job?.id and silently re-fetches the PREVIOUS job,
        // replacing "Job not found" (and the user's typed input) with old data.
        setParams({}, { replace: true });
      } else if (keepMsg) {
        // Post-action reload: the mutation itself was ACCEPTED by the server.
        // Replacing its success line with a red error would read as "the action
        // failed" and get the operator to run it a second time — report the
        // read-back failure alongside the outcome, not in place of it.
        setMsg((m) =>
          m
            ? { ok: m.ok, text: `${m.text} — couldn't reload: ${(e as Error).message}` }
            : { ok: false, text: (e as Error).message }
        );
      } else {
        // Network error / 5xx: the server being unreachable is not "job
        // removed" — keep whatever is loaded and surface the real error.
        setMsg({ ok: false, text: (e as Error).message });
      }
    } finally {
      if (my === lookupGen.current) {
        if (lookupAbort.current === controller) {
          lookupAbort.current = null;
          lookupIdentity.current = null;
        }
        setLoading(false);
      }
    }
  };

  const idParam = params.get('id');
  const customParam = params.get('custom');
  const renderedTarget: JobLookupTarget = {
    // connectionBaseUrl is selected above to trigger this render; getBaseUrl()
    // supplies the canonical value used by the actual transport snapshot.
    baseUrl: getBaseUrl(),
    authorization: connectionToken ? `Bearer ${connectionToken}` : undefined,
  };
  const jobBelongsToCurrentTarget = sameJobLookupTarget(jobTarget.current, renderedTarget);
  // biome-ignore lint/correctness/useExhaustiveDependencies: URL changes are the trigger; lookup is intentionally not a reactive dependency
  useEffect(() => {
    // React/router updates are not one atomic state store: clearing the job can
    // render once while its old ?id= is still visible. Suppress that transition
    // as well as the resulting empty location, then bind the terminal feedback
    // to that exact history entry. A later navigation to /job gets a new key
    // and therefore performs the normal full reset.
    if (internalEmptyUrlPending.current) {
      if (!idParam && !customParam) {
        internalEmptyUrlPending.current = false;
        preservedEmptyLocationKey.current = location.key;
      }
      return;
    }
    if (!idParam && !customParam && preservedEmptyLocationKey.current === location.key) return;
    preservedEmptyLocationKey.current = null;

    if (customParam) {
      if (job?.customId === customParam && jobBelongsToCurrentTarget) {
        // The custom lookup already resolved while the router was still
        // publishing its canonical ?id= URL. Do not issue the same two requests
        // again during that intermediate render.
        setLookupBy('id');
        setIdInput(job.id);
        setParams({ id: job.id }, { replace: true });
      } else {
        setLookupBy('custom');
        setIdInput(customParam);
        const currentLookup = lookupIdentity.current;
        if (currentLookup?.mode !== 'custom' || currentLookup.key !== customParam) {
          void lookup(customParam, 'custom', false, undefined, true);
        }
      }
    } else if (idParam && (idParam !== job?.id || !jobBelongsToCurrentTarget)) {
      setLookupBy('id');
      setIdInput(idParam);
      const currentLookup = lookupIdentity.current;
      if (currentLookup?.mode !== 'id' || currentLookup.key !== idParam) {
        void lookup(idParam, 'id', false, undefined, true);
      }
    } else if (!idParam && !customParam) {
      // Staying on the mounted /job route while history removes its lookup key
      // is still a navigation. Cancel every continuation and erase all data
      // owned by the previous URL so stale actions cannot remain operable.
      lookupGen.current += 1;
      lookupAbort.current?.abort();
      lookupAbort.current = null;
      lookupIdentity.current = null;
      actionGen.current += 1;
      jobTarget.current = null;
      setJob(null);
      setResult({ fetched: false, value: undefined });
      setResultError(null);
      setNotFound(false);
      setMsg(null);
      setLoading(false);
      setLookupBy('id');
      setIdInput('');
    }
  }, [
    idParam,
    customParam,
    job?.id,
    job?.customId,
    jobBelongsToCurrentTarget,
    location.key,
    connectionBaseUrl,
    connectionToken,
  ]);

  const submitLookup = (raw: string, mode: LookupMode = lookupBy) => {
    const key = raw.trim();
    if (!key || actionBusy.current) return;
    const routeAlreadyOwnsLookup =
      mode === 'id'
        ? idParam === key && customParam === null
        : customParam === key && idParam === null;
    if (routeAlreadyOwnsLookup) {
      // A retry/refresh for the current route does not need a navigation event.
      void lookup(key, mode);
      return;
    }
    // URL is the page's source of truth. Publishing the requested identity
    // first lets the route effect own exactly one cross-job lookup and prevents
    // the render caused by clearing A from interpreting stale ?id=A as a new
    // instruction that aborts B.
    setParams(mode === 'custom' ? { custom: key } : { id: key });
  };

  const act = async (label: string, fn: () => Promise<unknown>, confirmMsg?: string) => {
    // React state does not update until the click handler yields. A ref is the
    // actual mutex that closes the same-tick double-click window.
    if (!job || actionBusy.current || lookupAbort.current) return;
    const target = currentJobLookupTarget();
    if (!sameJobLookupTarget(jobTarget.current, target)) return;
    if (confirmMsg && !window.confirm(confirmMsg)) return;

    const my = ++actionGen.current;
    const actionJobId = job.id;
    actionLockOwner.current = my;
    actionBusy.current = true;
    setBusy(true);
    setMsg(null);

    const isCurrent = () =>
      mounted.current &&
      my === actionGen.current &&
      sameJobLookupTarget(target, currentJobLookupTarget()) &&
      sameJobLookupTarget(jobTarget.current, target);

    try {
      const accepted = await fn();
      if (
        !accepted ||
        typeof accepted !== 'object' ||
        Array.isArray(accepted) ||
        (accepted as { ok?: unknown }).ok !== true
      ) {
        throw new BqError('Invalid job mutation response: expected { ok: true }', 200);
      }
      if (!isCurrent()) return;
      setMsg({ ok: true, text: `${label} ✓` });
      if (label === 'Cancel') {
        internalEmptyUrlPending.current = true;
        preservedEmptyLocationKey.current = null;
        lookupGen.current += 1;
        jobTarget.current = null;
        setJob(null);
        setResult({ fetched: false, value: undefined });
        setResultError(null);
        // Clear the URL param too — otherwise the deep-link effect immediately
        // re-fetches the just-deleted job and replaces "Cancel ✓" with
        // "Job not found".
        setParams({}, { replace: true });
      } else {
        await lookup(actionJobId, 'id', true, my);
      }
    } catch (e) {
      if (isCurrent()) setMsg({ ok: false, text: (e as Error).message });
    } finally {
      if (actionLockOwner.current === my) {
        actionLockOwner.current = null;
        actionBusy.current = false;
        if (mounted.current) setBusy(false);
      }
    }
  };

  const state = job?.state;
  const err = job ? lastError(job) : null;
  const stackPreview = job?.stacktrace?.length ? buildStacktracePreview(job.stacktrace) : null;
  const hasStack = stackPreview !== null;
  const hasChildren = (job?.childrenIds?.length ?? 0) > 0;
  const dataReadOnlyReason = job ? jobDataReadOnlyReason(state, job) : null;
  // Failure-first: for a failed (DLQ'd) job the error IS the story — render it
  // above Data/Result instead of burying it below the payload.
  const failureFirst = state === 'failed';
  const errorCard =
    job && (err || hasStack) ? (
      <Card>
        <CardHeader title="Error" />
        {err && (
          <div className="mb-3">
            <p className="text-sm text-danger">{err.message}</p>
            <p className="mt-1 text-[11px] text-faint">
              {err.attempt != null ? `Attempt ${err.attempt} · ` : ''}
              {formatDateTime(err.timestamp)}
            </p>
          </div>
        )}
        {stackPreview && (
          <>
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-2 p-3 font-mono text-xs text-danger/90">
              {stackPreview.text}
            </pre>
            {stackPreview.truncated && (
              <p className="mt-2 text-xs text-faint">
                Stack preview truncated ({stackPreview.displayedLines} of {stackPreview.totalLines}{' '}
                lines, 262,144 characters maximum). Download JSON for the complete stored stack.
              </p>
            )}
          </>
        )}
      </Card>
    ) : null;

  return (
    <div>
      <PageHeader
        title="Job Inspector"
        description="Look up any job by ID and drive its full lifecycle."
        actions={
          job ? (
            <>
              {(hasChildren || job.parentId) && (
                <Link
                  to={`/flows?root=${encodeURIComponent(job.id)}`}
                  className="rounded-lg border border-line px-3 py-1.5 text-sm text-muted hover:bg-surface-2 hover:text-fg"
                >
                  View flow
                </Link>
              )}
              <Link
                to="/add-job"
                state={buildCloneState(job)}
                title="Enqueue a new job pre-filled from this one"
                className="rounded-lg border border-line px-3 py-1.5 text-sm text-muted hover:bg-surface-2 hover:text-fg"
              >
                Clone
              </Link>
              <Button
                size="sm"
                onClick={() =>
                  downloadJson(
                    `job-${job.id}`,
                    result.fetched ? { ...job, result: result.value } : job
                  )
                }
              >
                <IconDownload className="size-3.5" /> Download JSON
              </Button>
            </>
          ) : undefined
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <Select
          name="job-lookup-mode"
          autoComplete="off"
          value={lookupBy}
          aria-label="Lookup mode"
          onChange={(e) => setLookupBy(e.target.value as LookupMode)}
          className="w-40"
        >
          <option value="id">By job ID</option>
          <option value="custom">By custom ID</option>
        </Select>
        <div className="relative min-w-56 flex-1">
          <IconSearch className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
          <input
            value={idInput}
            aria-label={lookupBy === 'custom' ? 'Custom job ID' : 'Job ID'}
            name="job-lookup-id"
            autoComplete="off"
            spellCheck={false}
            maxLength={1024}
            onInput={(e) => setIdInput(e.currentTarget.value)}
            onKeyDown={(e) => e.key === 'Enter' && submitLookup(idInput)}
            placeholder={
              lookupBy === 'custom'
                ? 'custom / idempotency id — Enter to look up'
                : 'job id (UUID) — Enter to look up'
            }
            className="h-9 w-full rounded-lg border border-line bg-surface pl-9 pr-3 font-mono text-sm text-fg placeholder:text-faint focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
        </div>
        <Button variant="accent" disabled={loading || busy} onClick={() => submitLookup(idInput)}>
          Look up
        </Button>
      </div>

      {msg && (
        <div
          role="status"
          className={msg.ok ? 'mb-4 text-sm text-success' : 'mb-4 text-sm text-danger'}
        >
          {msg.text}
        </div>
      )}

      {loading && !job ? (
        <LoadingState label="Loading job…" />
      ) : notFound ? (
        <EmptyState title="Job not found" hint="Check the ID, or the job may have been removed." />
      ) : !job ? (
        <EmptyState title="No job loaded" hint="Enter a job ID above to inspect it." />
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <div className="flex flex-col gap-6 lg:col-span-2">
            <Card>
              <div className="mb-4 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-1">
                    <div className="truncate font-mono text-sm text-fg">{job.id}</div>
                    <CopyButton value={job.id} />
                  </div>
                  <div className="mt-1 font-mono text-xs text-faint">{job.queue}</div>
                </div>
                <StatusBadge status={state ?? 'unknown'} />
              </div>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
                <Kv k="Priority" v={String(job.priority ?? 0)} />
                <Kv k="Name" v={job.name ?? 'default'} />
                <Kv k="Attempts" v={`${job.attempts ?? 0} / ${job.maxAttempts ?? '?'}`} />
                <Kv k="Progress" v={`${job.progress ?? 0}%`} />
                <Kv k="Created" v={formatDateTime(job.createdAt)} />
                <Kv k="Started" v={formatDateTime(job.startedAt ?? undefined)} />
                <Kv k="Completed" v={formatDateTime(job.completedAt ?? undefined)} />
                <Kv
                  k="Duration"
                  v={formatDuration(
                    job.startedAt && job.completedAt ? job.completedAt - job.startedAt : undefined
                  )}
                />
                <div>
                  <dt className="text-[11px] uppercase tracking-wider text-faint">Custom ID</dt>
                  <dd className="flex items-center gap-1 text-fg">
                    <span className="truncate font-mono">{job.customId ?? '—'}</span>
                    {job.customId && <CopyButton value={job.customId} />}
                  </dd>
                </div>
              </dl>
            </Card>

            {failureFirst && errorCard}

            <JobDataEditor
              key={`data-${job.id}`}
              data={job.data}
              busy={busy}
              editable={dataReadOnlyReason === null}
              readOnlyReason={dataReadOnlyReason ?? undefined}
              onSave={(parsed) => act('Data', () => bq.updateJobData(job.id, parsed))}
            />

            {state === 'completed' && (
              <Card>
                <CardHeader
                  title="Result"
                  action={
                    result.fetched && result.value !== undefined && result.value !== null ? (
                      <JsonToolbar value={result.value} filename={`job-${job.id}-result`} />
                    ) : undefined
                  }
                />
                {result.fetched && result.value !== undefined && result.value !== null ? (
                  <Json value={result.value} />
                ) : resultError ? (
                  <div className="flex flex-wrap items-center gap-3">
                    <p className="text-xs text-danger">Couldn't load result — {resultError}</p>
                    <Button size="sm" disabled={loading} onClick={() => lookup(job.id, 'id')}>
                      Retry
                    </Button>
                  </div>
                ) : (
                  <p className="text-xs text-faint">No result stored for this job.</p>
                )}
              </Card>
            )}

            {!failureFirst && errorCard}

            <JobLogs key={`logs-${job.id}`} jobId={job.id} />
            {hasChildren && <JobChildren key={`children-${job.id}`} jobId={job.id} />}
            <JobTimeline timeline={job.timeline} />
            <JobBackoff job={job} />
          </div>

          {/* On mobile the single column stacks in source order — pull the
              actions up so they sit right under the header, not below every
              read-only card. lg restores the right-rail position. */}
          <div className="order-first lg:order-none">
            <JobActionsPanel job={job} busy={busy} act={act} />
          </div>
        </div>
      )}
    </div>
  );
}

function Kv({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wider text-faint">{k}</dt>
      <dd className="text-fg">{v}</dd>
    </div>
  );
}

function Json({ value }: { value: unknown }) {
  return (
    <pre className="max-h-64 overflow-auto rounded-lg bg-surface-2 p-3 font-mono text-xs text-muted">
      {JSON.stringify(value ?? null, null, 2)}
    </pre>
  );
}

/** Copy + download controls for a JSON blob, shown in a card header. */
function JsonToolbar({ value, filename }: { value: unknown; filename: string }) {
  return (
    <div className="flex items-center gap-1">
      <CopyButton value={JSON.stringify(value ?? null, null, 2)} />
      <IconButton
        aria-label="Download JSON"
        title="Download JSON"
        onClick={() => downloadJson(filename, value ?? null)}
      >
        <IconDownload className="size-3.5" />
      </IconButton>
    </div>
  );
}
