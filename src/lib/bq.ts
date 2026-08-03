/**
 * Full-control bunqueue client — the complete, verified surface used by the
 * control pages. Additive: it does not modify the original lib/api.ts.
 *
 * Reads base URL + token from the connection store; talks to the control agent
 * (process lifecycle) at VITE_BUNQUEUE_AGENT_URL (default http://localhost:6800).
 */
import {
  getAgentAuthHeaders,
  getAuthHeaders,
  getBaseUrl,
  normalizeBaseUrl,
} from '@/components/dashboard/stores/connectionStore';
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
} from './bqTypes';
import {
  parseQueueSummaryPayload,
  parseWebhooksPayload,
  parseWorkersPayload,
} from './dashboardPayloads';
import type { OverviewResponse, QueueDetailResponse, QueuesResponse, StatsResponse } from './types';
import {
  decodedHttpPathSegment,
  eventQueuePathSegment,
  opaqueHttpIdError,
  opaqueHttpPathSegment,
  queueHttpPathSegment,
} from './upstreamPaths';

/** Browse-grid filter (mirrors agent/db.ts DbFilter). */
export interface DbFilter {
  column: string;
  op: 'contains' | 'eq' | 'ne';
  value: string;
}

/** SQLite rowids outside JS's safe integer range are serialized as strings. */
export type DbRowId = number | string;

/** One page of table rows from the read-only inspector (mirrors agent/db.ts). */
export interface DbRowsPage {
  ok: boolean;
  table: string;
  columns: string[];
  rows: unknown[][];
  rowids: (DbRowId | null)[];
  truncatedCells: boolean[][];
  total: number;
  limit: number;
  offset: number;
  orderBy: string | null;
  dir: 'asc' | 'desc';
  filter: DbFilter | null;
}

/** One immutable table view requested from the agent's atomic CSV exporter. */
export interface DbExportRequest {
  table: string;
  orderBy?: string;
  dir: 'asc' | 'desc';
  filter?: DbFilter;
}

export type DbExportCap = 'rows' | 'bytes' | null;

/** Validated, bounded raw CSV response from the control agent. */
export interface DbCsvExportResult {
  table: string;
  content: Uint8Array<ArrayBuffer>;
  rowCount: number;
  bytes: number;
  cap: DbExportCap;
}

/** Must match agent/db.ts; responses above either ceiling are rejected client-side too. */
export const DB_EXPORT_MAX_ROWS = 200_000;
export const DB_EXPORT_MAX_BYTES = 16 * 1024 * 1024;
const DB_EXPORT_TIMEOUT_MS = 120_000;
const DB_EXPORT_ERROR_MAX_BYTES = 64 * 1024;

export class BqError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'BqError';
  }
}

/**
 * Per-request deadline. fetch has no default timeout, so a reachable-but-hung
 * server (SIGSTOPped process, half-open socket) would leave the promise pending
 * forever — and usePolledData schedules its next tick only AFTER the current one
 * settles, so the page would stop polling for the lifetime of the mount.
 * Overridable (tests set it low so they never sleep); caller cancellation is
 * composed with the deadline. Bulk operations select their longer deadline
 * explicitly instead of bypassing timeout protection with a signal.
 */
let requestTimeoutMs = 30_000;
export function setRequestTimeoutMs(ms: number): void {
  requestTimeoutMs = ms;
}

async function call<T>(
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
  // A lifecycle AbortSignal (route/connection generation) is cancellation, not
  // a replacement for the network deadline. Compose both so a half-open socket
  // cannot pin a generation forever.
  const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  const requestHeaders = new Headers(headers);
  if (init?.headers) {
    new Headers(init.headers).forEach((value, name) => {
      requestHeaders.set(name, value);
    });
  }
  // A Content-Type header on a GET is unnecessary and turns a simple CORS read
  // into a preflight. Apply the JSON default only to requests carrying a body;
  // callers may still override it with any HeadersInit representation.
  if (init?.body != null && !requestHeaders.has('Content-Type')) {
    requestHeaders.set('Content-Type', 'application/json');
  }
  let res: Response;
  try {
    res = await fetch(base + path, {
      ...init,
      headers: requestHeaders,
      signal,
    });
  } catch (e) {
    // A blown deadline must surface as the normal error type (status 0 — no
    // response was received), so callers show an error instead of hanging.
    if (
      (deadline.aborted && !init?.signal?.aborted) ||
      (e as { name?: string } | null)?.name === 'TimeoutError'
    ) {
      throw new BqError('Request timed out', 0);
    }
    throw e;
  }
  if (!res.ok && !acceptedStatuses.includes(res.status)) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      /* non-JSON */
    }
    // A 401 means a bearer token is missing or wrong. Signal the UI (AuthGate)
    // to prompt for it, scoped to which backend rejected us — a server 401 asks
    // for the bunqueue token, an agent 401 (AGENT_TOKEN) asks for the agent
    // token; prompting for the wrong one is an unfixable loop. Then still throw
    // so callers see the failure. Guarded for non-browser contexts (tests).
    // `auth` and `target` carry the immutable request identity, so a listener
    // can drop a 401 produced by an in-flight request issued with an OLD token
    // or against a backend the operator has since left (either would otherwise
    // re-lock the gate for the wrong connection).
    if (res.status === 401 && typeof window !== 'undefined') {
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
    throw new BqError(message, res.status);
  }
  if (res.status === 204) return undefined as T;
  // Defensive parse: a 2xx with an empty or non-JSON body must surface as a
  // BqError (consistent error type), not a raw SyntaxError from res.json().
  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    if (deadline.aborted && !init?.signal?.aborted) {
      throw new BqError('Request timed out', 0);
    }
    throw e;
  }
  if (!text) return undefined as T;
  let data: T;
  try {
    data = JSON.parse(text) as T;
  } catch {
    throw new BqError(`Invalid JSON response (HTTP ${res.status})`, res.status);
  }
  // Many mutating endpoints return HTTP 200 with { ok:false, error } on logical
  // failure (cancel a finished job, purge unknown queue, …). Surface those as
  // errors instead of resolving as success. `strict:false` opts out for the rare
  // endpoint where `ok` is a semantic status flag rather than a success flag —
  // GET /health sets `ok: isHealthy` (disk-full → ok:false + HTTP 503, but the
  // structured body is still the diagnostic payload the caller needs).
  if (strict && data && typeof data === 'object' && (data as { ok?: unknown }).ok === false) {
    const err = (data as { error?: string }).error;
    throw new BqError(err ?? 'Operation failed', res.status);
  }
  return data;
}

const srv = <T>(
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

// Agent base resolution, in priority order:
//   1. Runtime injection — the all-in-one server (scripts/serve.ts) injects
//      `window.__BUNQUEUE_AGENT_URL__ = '/agent'` into index.html and proxies
//      that path to its own agent, so a custom AGENT_PORT (or remote access,
//      where loopback :6800 is unreachable) works with the prebuilt SPA.
//   2. VITE_BUNQUEUE_AGENT_URL baked at build time.
//   3. The dev default, the local agent on :6800.
export const SAFE_AGENT_BASE = 'http://localhost:6800';

export function resolveAgentBase(runtimeValue: unknown, envValue: unknown): string {
  return normalizeBaseUrl(runtimeValue) ?? normalizeBaseUrl(envValue) ?? SAFE_AGENT_BASE;
}

function readRuntimeAgentBase(): unknown {
  try {
    return (globalThis as { __BUNQUEUE_AGENT_URL__?: unknown }).__BUNQUEUE_AGENT_URL__;
  } catch {
    return undefined;
  }
}

// Snapshot once at module initialization. Runtime injection remains useful for
// the all-in-one server, but later global mutation cannot redirect an already
// running dashboard after the operator has entered an agent bearer token.
const AGENT = resolveAgentBase(readRuntimeAgentBase(), import.meta.env.VITE_BUNQUEUE_AGENT_URL);
const agent = <T>(path: string, init?: RequestInit): Promise<T> =>
  call<T>(AGENT, path, getAgentAuthHeaders(), init, true, 'agent');

const q = (s: string) => encodeURIComponent(s);

/** Opaque snapshot of one server origin and its matching bearer credential. */
export interface ServerRequestTarget {
  readonly baseUrl: string;
}

const serverTargetHeaders = new WeakMap<ServerRequestTarget, Readonly<Record<string, string>>>();

/** Opaque snapshot of the control-agent origin and its matching bearer credential. */
export interface AgentRequestTarget {
  readonly baseUrl: string;
}

const agentTargetHeaders = new WeakMap<AgentRequestTarget, Readonly<Record<string, string>>>();

export function captureServerRequestTarget(): ServerRequestTarget {
  const target = Object.freeze({ baseUrl: getBaseUrl() });
  serverTargetHeaders.set(target, Object.freeze({ ...getAuthHeaders() }));
  return target;
}

function sameHeaders(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>
): boolean {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  if (leftEntries.length !== rightEntries.length) return false;
  return leftEntries.every(([name, value]) => right[name] === value);
}

/**
 * Fail closed when an approval was rendered for a server/credential pair that
 * is no longer selected. The target's bearer remains private in the WeakMap;
 * callers can only ask whether it still matches the live connection.
 */
export function assertCurrentServerRequestTarget(target: ServerRequestTarget): void {
  const captured = serverTargetHeaders.get(target);
  if (!captured) throw new TypeError('Invalid server request target.');
  if (target.baseUrl !== getBaseUrl() || !sameHeaders(captured, getAuthHeaders())) {
    throw new Error(
      `Server connection changed after confirmation was requested for ${target.baseUrl}; action refused.`
    );
  }
}

export function captureAgentRequestTarget(): AgentRequestTarget {
  const target = Object.freeze({ baseUrl: AGENT });
  agentTargetHeaders.set(target, Object.freeze({ ...getAgentAuthHeaders() }));
  return target;
}

/**
 * Read a job against the captured server even if Settings changes mid-walk.
 * The WeakMap makes targets non-forgeable and keeps the bearer token private.
 */
export async function getJobAtTarget(
  target: ServerRequestTarget,
  id: string,
  signal?: AbortSignal
): Promise<{ ok: boolean; job: JobFull }> {
  signal?.throwIfAborted();
  const headers = serverTargetHeaders.get(target);
  if (!headers) throw new TypeError('Invalid server request target.');
  const result = await call<{ ok: boolean; job: JobFull }>(
    target.baseUrl,
    `/jobs/${opaqueHttpPathSegment(id)}`,
    { ...headers },
    signal ? { signal } : undefined
  );
  // Some test doubles and non-standard fetch implementations ignore signals.
  // Do not let their late response advance a traversal after cancellation.
  signal?.throwIfAborted();
  return result;
}

/** Read one database page through an immutable control-agent target. */
export async function getDbRowsAtTarget(
  target: AgentRequestTarget,
  table: string,
  limit = 50,
  offset = 0,
  orderBy?: string,
  dir: 'asc' | 'desc' = 'asc',
  filter?: DbFilter,
  signal?: AbortSignal
): Promise<DbRowsPage> {
  signal?.throwIfAborted();
  const headers = agentTargetHeaders.get(target);
  if (!headers) throw new TypeError('Invalid agent request target.');
  const result = await call<DbRowsPage>(
    target.baseUrl,
    `/db/tables/${decodedHttpPathSegment(table, 'Database table')}?limit=${limit}&offset=${offset}` +
      (orderBy ? `&orderBy=${q(orderBy)}&dir=${dir}` : '') +
      (filter?.value ? `&fcol=${q(filter.column)}&fop=${filter.op}&fval=${q(filter.value)}` : ''),
    { ...headers },
    signal ? { signal } : undefined,
    true,
    'agent'
  );
  signal?.throwIfAborted();
  return result;
}

function parseExportIntegerHeader(
  headers: Headers,
  name: string,
  maximum: number,
  allowZero = true
): number {
  const raw = headers.get(name);
  if (!raw || !/^\d+$/.test(raw)) {
    throw new BqError(`Malformed database export response: invalid ${name} header.`, 200);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > maximum || (!allowZero && value === 0)) {
    throw new BqError(`Malformed database export response: invalid ${name} header.`, 200);
  }
  return value;
}

async function readSmallErrorBody(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const bytes = new Uint8Array(DB_EXPORT_ERROR_MAX_BYTES);
  let used = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (used + next.value.byteLength > bytes.byteLength) {
        void reader.cancel().catch(() => undefined);
        return '';
      }
      bytes.set(next.value, used);
      used += next.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(bytes.subarray(0, used));
}

async function readExactExportBody(
  response: Response,
  expectedBytes: number,
  signal?: AbortSignal
): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.body) {
    throw new BqError('Malformed database export response: missing CSV body.', 200);
  }
  const content = new Uint8Array(expectedBytes);
  const reader = response.body.getReader();
  let used = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      if (used + next.value.byteLength > expectedBytes) {
        void reader.cancel().catch(() => undefined);
        throw new BqError(
          `Malformed database export response: body exceeds declared ${expectedBytes} bytes.`,
          200
        );
      }
      content.set(next.value, used);
      used += next.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  signal?.throwIfAborted();
  if (used !== expectedBytes) {
    throw new BqError(
      `Malformed database export response: received ${used} of ${expectedBytes} declared bytes.`,
      200
    );
  }
  return content;
}

/**
 * Fetch one server-generated CSV through an immutable agent URL/credential.
 * Header metadata and the body length are validated before any bytes reach the
 * download path; the reader allocates exactly the declared, hard-capped size.
 */
export async function getDbExportAtTarget(
  target: AgentRequestTarget,
  requested: Readonly<DbExportRequest>,
  signal?: AbortSignal
): Promise<DbCsvExportResult> {
  signal?.throwIfAborted();
  const captured = agentTargetHeaders.get(target);
  if (!captured) throw new TypeError('Invalid agent request target.');
  if (!requested || typeof requested !== 'object' || Array.isArray(requested)) {
    throw new TypeError('Invalid database export request.');
  }
  if (typeof requested.table !== 'string' || !requested.table) {
    throw new TypeError('Database export table must not be empty.');
  }
  if (requested.dir !== 'asc' && requested.dir !== 'desc') {
    throw new TypeError('Invalid database export sort direction.');
  }
  if (
    requested.orderBy !== undefined &&
    (typeof requested.orderBy !== 'string' || !requested.orderBy)
  ) {
    throw new TypeError('Database export sort column must not be empty.');
  }
  if (
    requested.filter &&
    (typeof requested.filter !== 'object' ||
      Array.isArray(requested.filter) ||
      typeof requested.filter.column !== 'string' ||
      !requested.filter.column ||
      typeof requested.filter.value !== 'string' ||
      !requested.filter.value ||
      (requested.filter.op !== 'contains' &&
        requested.filter.op !== 'eq' &&
        requested.filter.op !== 'ne'))
  ) {
    throw new TypeError('Invalid database export filter.');
  }

  const snapshot: DbExportRequest = Object.freeze({
    table: requested.table,
    orderBy: requested.orderBy,
    dir: requested.dir,
    filter: requested.filter ? Object.freeze({ ...requested.filter }) : undefined,
  });
  const search = new URLSearchParams();
  if (snapshot.orderBy) search.set('orderBy', snapshot.orderBy);
  search.set('dir', snapshot.dir);
  if (snapshot.filter) {
    search.set('fcol', snapshot.filter.column);
    search.set('fop', snapshot.filter.op);
    search.set('fval', snapshot.filter.value);
  }
  const path = `/db/tables/${decodedHttpPathSegment(snapshot.table, 'Database table')}/export?${search}`;
  const deadline = AbortSignal.timeout(DB_EXPORT_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const headers = { ...captured };

  try {
    const response = await fetch(target.baseUrl + path, { headers, signal: requestSignal });
    if (!response.ok) {
      if (response.status === 401 && typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent('auth:required', {
            detail: {
              scope: 'agent',
              auth: new Headers(headers).get('Authorization') ?? undefined,
              target: target.baseUrl,
            },
          })
        );
      }
      let message = `HTTP ${response.status}`;
      const text = await readSmallErrorBody(response);
      if (text) {
        try {
          const body = JSON.parse(text) as unknown;
          if (
            body !== null &&
            typeof body === 'object' &&
            !Array.isArray(body) &&
            typeof (body as { error?: unknown }).error === 'string'
          ) {
            message = (body as { error: string }).error;
          }
        } catch {
          /* keep the HTTP status for a non-JSON error body */
        }
      }
      throw new BqError(message, response.status);
    }

    if (response.headers.get('X-Bunqueue-Db-Export-Version') !== '1') {
      throw new BqError('Malformed database export response: unsupported contract version.', 200);
    }
    const contentType = response.headers.get('Content-Type') ?? '';
    if (!/^text\/csv(?:;|$)/i.test(contentType)) {
      throw new BqError('Malformed database export response: expected CSV content.', 200);
    }
    const encodedTable = response.headers.get('X-Bunqueue-Db-Export-Table');
    let responseTable: string;
    try {
      if (!encodedTable) throw new Error('missing');
      responseTable = decodeURIComponent(encodedTable);
    } catch {
      throw new BqError('Malformed database export response: invalid table identity.', 200);
    }
    if (responseTable !== snapshot.table) {
      throw new BqError(
        `Database export target changed: requested "${snapshot.table}", received "${responseTable}".`,
        200
      );
    }

    const rowCount = parseExportIntegerHeader(
      response.headers,
      'X-Bunqueue-Db-Export-Rows',
      DB_EXPORT_MAX_ROWS
    );
    const bytes = parseExportIntegerHeader(
      response.headers,
      'X-Bunqueue-Db-Export-Bytes',
      DB_EXPORT_MAX_BYTES,
      false
    );
    const contentLength = parseExportIntegerHeader(
      response.headers,
      'Content-Length',
      DB_EXPORT_MAX_BYTES,
      false
    );
    if (contentLength !== bytes) {
      throw new BqError(
        'Malformed database export response: Content-Length does not match X-Bunqueue-Db-Export-Bytes.',
        200
      );
    }
    const capHeader = response.headers.get('X-Bunqueue-Db-Export-Cap');
    if (capHeader !== 'none' && capHeader !== 'rows' && capHeader !== 'bytes') {
      throw new BqError('Malformed database export response: invalid export cap.', 200);
    }
    if (capHeader === 'rows' && rowCount !== DB_EXPORT_MAX_ROWS) {
      throw new BqError('Malformed database export response: inconsistent row cap.', 200);
    }
    const content = await readExactExportBody(response, bytes, requestSignal);
    signal?.throwIfAborted();
    return {
      table: responseTable,
      content,
      rowCount,
      bytes,
      cap: capHeader === 'none' ? null : capHeader,
    };
  } catch (error) {
    if (deadline.aborted && !signal?.aborted) throw new BqError('Database export timed out', 0);
    throw error;
  }
}

const body = (method: string, b?: unknown): RequestInit => ({
  method,
  body: b === undefined ? undefined : JSON.stringify(b),
});

/**
 * Deadline for the few endpoints whose work scales with the request: a 10k-job
 * bulk insert or a drain of a huge queue can legitimately outrun the default
 * 30s. Aborting those is worse than waiting — the server has usually committed
 * the write, so the client reports a timeout the operator "fixes" by
 * resubmitting, duplicating every job that lacks a jobId/uniqueKey.
 */
const BULK_TIMEOUT_MS = 300_000;
const bulkBody = (method: string, b?: unknown): RequestInit => body(method, b);

/** Backoff on a job: a flat delay, or a strategy with a base delay. */
export type Backoff = number | { type: 'fixed' | 'exponential'; delay: number };

/**
 * Repeat policy the dashboard can execute safely against bunqueue v2.8.55.
 *
 * Upstream's wider public type also exposes `pattern` and scheduler metadata,
 * but the HTTP/server continuation path drops that metadata and treats a
 * pattern-only repeat as `delay: 0`. Keep this client surface deliberately
 * narrow: cron expressions belong to the dedicated /crons API.
 */
export interface RepeatOptions {
  every: number;
  limit?: number;
}

const MAX_REPEAT_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Defense in depth for non-form callers. The UI validates this already, but a
 * future page or Copilot tool must not be able to send the unsafe upstream
 * pattern shape by calling bq.addJob/addJobsBulk directly.
 */
function assertSafeRepeat(repeat: RepeatOptions | undefined): void {
  if (repeat === undefined) return;
  if (repeat === null || typeof repeat !== 'object' || Array.isArray(repeat)) {
    throw new TypeError('Repeat must be an object with a positive "every" interval');
  }
  const unsupported = Object.keys(repeat).filter((key) => key !== 'every' && key !== 'limit');
  if (unsupported.length > 0) {
    throw new TypeError(
      `Unsupported repeat option(s): ${unsupported.join(', ')}. bunqueue v2.8.55 pattern repeats are unsafe; use the Cron API instead.`
    );
  }
  if (!Number.isSafeInteger(repeat.every) || repeat.every < 1 || repeat.every > MAX_REPEAT_MS) {
    throw new TypeError(`Repeat "every" must be a whole number from 1 to ${MAX_REPEAT_MS} ms`);
  }
  if (repeat.limit !== undefined && (!Number.isSafeInteger(repeat.limit) || repeat.limit < 1)) {
    throw new TypeError('Repeat "limit" must be a whole number of at least 1');
  }
}

/** Deduplication policy accepted by bulk job input and cron definitions. */
export interface DedupOptions {
  ttl?: number;
  extend?: boolean;
  replace?: boolean;
}

/** Memory figures reported by the server, already rounded to whole megabytes. */
export interface HeapMB {
  heapUsed: number;
  heapTotal: number;
  rss: number;
}

export interface AddJobBody {
  data: unknown;
  priority?: number;
  delay?: number;
  maxAttempts?: number;
  backoff?: Backoff;
  timeout?: number;
  jobId?: string;
  removeOnComplete?: boolean;
  removeOnFail?: boolean;
  durable?: boolean;
  ttl?: number;
  uniqueKey?: string;
  lifo?: boolean;
  // Advanced (all honored by the single-push HTTP route): free-form tags, a
  // group key for grouped processing, and parent-job ids this job depends on.
  tags?: string[];
  groupId?: string;
  dependsOn?: string[];
  repeat?: RepeatOptions;
}

/** Extra PUSHB fields that v2.8.55 executes with reliable runtime semantics. */
export interface BulkJobBody extends AddJobBody {
  stallTimeout?: number;
  dedup?: DedupOptions;
  stackTraceLimit?: number;
  timestamp?: number;
}

function assertManageableJobInput(job: AddJobBody): void {
  const ids = [
    ...(job.jobId === undefined ? [] : [['jobId', job.jobId] as const]),
    ...(job.dependsOn ?? []).map((id) => ['dependsOn', id] as const),
  ];
  for (const [field, id] of ids) {
    const error = opaqueHttpIdError(id);
    if (error) {
      throw new TypeError(
        `${field}: ${error}. The job would not be manageable through v2.8.55 HTTP.`
      );
    }
  }
}

const UNSAFE_BULK_JOB_FIELDS = [
  'childrenIds',
  'parentId',
  'failParentOnFailure',
  'removeDependencyOnFailure',
  'continueParentOnFailure',
  'ignoreDependencyOnFailure',
  'keepLogs',
  'sizeLimit',
  'debounceId',
  'debounceTtl',
] as const;

function assertSafeBulkJob(job: BulkJobBody): void {
  const raw = job as unknown as Record<string, unknown>;
  const unsafe = UNSAFE_BULK_JOB_FIELDS.filter((field) => raw[field] !== undefined);
  if (unsafe.length > 0) {
    throw new TypeError(
      `Unsupported Bunqueue v2.8.55 enqueue option(s): ${unsafe.join(', ')}. Flow topology must use the atomic flow API; inert compatibility fields are not sent.`
    );
  }
}

/**
 * Capture, validate, and return the exact single-job body that will be sent.
 * Validating the caller's live object and serializing it later is unsafe:
 * mutable getters or a root toJSON() can expose one value to the preflight and
 * a different repeat/topology/id value to fetch.
 */
function encodedAddJobRequest(job: AddJobBody): string {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(job);
  } catch {
    throw new TypeError('Job payload must be JSON serializable');
  }
  if (encoded === undefined) throw new TypeError('Job payload must be JSON serializable');

  let value: unknown;
  try {
    value = JSON.parse(encoded) as unknown;
  } catch {
    // JSON.stringify() produced this value, so reaching this branch would mean
    // a runtime invariant changed. Keep the transport fail-closed regardless.
    throw new TypeError('Job payload encoding failed');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Job payload must serialize to a JSON object');
  }

  const raw = value as Record<string, unknown>;
  assertSafeRepeat(raw.repeat as RepeatOptions | undefined);
  assertSafeBulkJob(raw as unknown as BulkJobBody);
  if (
    raw.dependsOn !== undefined &&
    (!Array.isArray(raw.dependsOn) || !raw.dependsOn.every((id) => typeof id === 'string'))
  ) {
    throw new TypeError('dependsOn must be an array of job ID strings');
  }
  assertManageableJobInput(raw as unknown as AddJobBody);
  return encoded;
}

/** The bulk route consumes the domain `JobInput` shape, where jobId is customId. */
function toBulkJob({ jobId, ...job }: BulkJobBody): Omit<BulkJobBody, 'jobId'> & {
  customId?: string;
} {
  return jobId === undefined ? job : { ...job, customId: jobId };
}

/** Validate the plain JSON value reconstructed from the exact fragment that
 * will be sent. Reading the caller's live object before serialization would
 * let mutable getters pass validation and then emit different topology/repeat
 * fields during the request pass. */
function assertSafeEncodedBulkJob(encoded: string): void {
  const value = JSON.parse(encoded) as unknown;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('must serialize to a JSON object');
  }
  const raw = value as Record<string, unknown>;
  if (raw.jobId !== undefined) {
    throw new TypeError('serialized jobId is invalid; the bulk transport requires customId');
  }

  assertSafeRepeat(raw.repeat as RepeatOptions | undefined);
  assertSafeBulkJob(raw as unknown as BulkJobBody);

  if (raw.customId !== undefined) {
    if (typeof raw.customId !== 'string') throw new TypeError('customId must be a string');
    const error = opaqueHttpIdError(raw.customId);
    if (error) {
      throw new TypeError(
        `customId: ${error}. The job would not be manageable through v2.8.55 HTTP.`
      );
    }
  }

  if (raw.dependsOn !== undefined) {
    if (!Array.isArray(raw.dependsOn) || !raw.dependsOn.every((id) => typeof id === 'string')) {
      throw new TypeError('dependsOn must be an array of job ID strings');
    }
    for (const dependency of raw.dependsOn as string[]) {
      const error = opaqueHttpIdError(dependency);
      if (error) {
        throw new TypeError(
          `dependsOn: ${error}. The job would not be manageable through v2.8.55 HTTP.`
        );
      }
    }
  }
}

/**
 * Maximum JSON transport envelope accepted from dashboard bulk producers.
 * Bunqueue v2.8.55 limits each job's data but does not cap data x job count,
 * so the client must prevent a valid request from allocating tens of GiB.
 */
export const MAX_BULK_JOB_PAYLOAD_BYTES = 64 * 1024 * 1024;
export const MAX_BULK_JOB_COUNT = 10_000;

function boundedUtf8Bytes(text: string, stopAfter: number): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit <= 0x7f) bytes += 1;
    else if (unit <= 0x7ff) bytes += 2;
    else if (
      unit >= 0xd800 &&
      unit <= 0xdbff &&
      index + 1 < text.length &&
      text.charCodeAt(index + 1) >= 0xdc00 &&
      text.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
    if (bytes > stopAfter) return bytes;
  }
  return bytes;
}

type BulkPayloadResult = { ok: true; bytes: number; body?: string } | { ok: false; error: string };

/**
 * Serialize each job at most once in this pass and account for the exact
 * `{jobs:[...]}` UTF-8 envelope. Request mode retains only a bounded set of
 * already-measured fragments and joins them once; the caller then sends that
 * same string, so getters/toJSON cannot change between validation and fetch.
 */
function serializeBulkJobPayload(
  jobs: readonly BulkJobBody[],
  maxBytes: number,
  buildBody: boolean
): BulkPayloadResult {
  if (!Array.isArray(jobs) || jobs.length > MAX_BULK_JOB_COUNT) {
    return {
      ok: false,
      error: `Bulk request must contain at most ${MAX_BULK_JOB_COUNT} jobs`,
    };
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    return { ok: false, error: 'Bulk request payload limit is invalid' };
  }

  // `{"jobs":[]}` is eleven ASCII bytes. Each non-first item adds one comma.
  const jobCount = jobs.length;
  let totalBytes = 11;
  const parts = buildBody ? new Array<string>(jobCount) : null;
  for (let index = 0; index < jobCount; index++) {
    if (index > 0) totalBytes += 1;
    if (totalBytes > maxBytes) {
      return {
        ok: false,
        error: 'Bulk request payload exceeds the 64 MiB UTF-8 safety limit',
      };
    }

    let encoded: string | undefined;
    try {
      encoded = JSON.stringify(toBulkJob(jobs[index]));
    } catch {
      return { ok: false, error: 'Bulk request payload must be JSON serializable' };
    }
    if (encoded === undefined) {
      return { ok: false, error: 'Bulk request payload must be JSON serializable' };
    }
    const encodedBytes = boundedUtf8Bytes(encoded, maxBytes - totalBytes);
    totalBytes += encodedBytes;
    if (totalBytes > maxBytes) {
      return {
        ok: false,
        error: 'Bulk request payload exceeds the 64 MiB UTF-8 safety limit',
      };
    }
    if (buildBody) {
      try {
        assertSafeEncodedBulkJob(encoded);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: `Bulk job ${index + 1}: ${message}` };
      }
    }
    if (parts) parts[index] = encoded;
  }
  return {
    ok: true,
    bytes: totalBytes,
    body: parts ? `{"jobs":[${parts.join(',')}]}` : undefined,
  };
}

/** Allocation-light form preflight. Core transport repeats the measurement in
 * request mode and sends its captured string, so even non-idempotent values
 * cannot create a time-of-check/time-of-use size bypass. */
export function bulkJobPayloadBudgetError(
  jobs: readonly BulkJobBody[],
  maxBytes = MAX_BULK_JOB_PAYLOAD_BYTES
): string | null {
  const result = serializeBulkJobPayload(jobs, maxBytes, false);
  return result.ok ? null : result.error;
}

function encodedBulkJobRequest(jobs: readonly BulkJobBody[]): string {
  const result = serializeBulkJobPayload(jobs, MAX_BULK_JOB_PAYLOAD_BYTES, true);
  if (!result.ok) throw new TypeError(result.error);
  // Request mode always supplies the joined body; keep this assertion local so
  // an internal refactor can never fall back to a second JSON.stringify pass.
  if (result.body === undefined) throw new TypeError('Bulk request payload encoding failed');
  return result.body;
}

function assertBulkJobCount(jobs: readonly BulkJobBody[]): void {
  if (!Array.isArray(jobs) || jobs.length > MAX_BULK_JOB_COUNT) {
    throw new TypeError(`Bulk request must contain at most ${MAX_BULK_JOB_COUNT} jobs`);
  }
}

/**
 * Target-scoped subset used by multi-request operations such as Benchmark.
 * Every method reuses the URL and bearer credential captured together at the
 * operation boundary, so changing Settings midway cannot split one operation
 * across two servers (or send server A's continuation with server B's token).
 */
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
    opts?: { grace?: number; state?: string; limit?: number }
  ) => Promise<{ ok: boolean; count: number }>;
}

function responseRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BqError(`Malformed ${label} response.`, 200);
  }
  return value as Record<string, unknown>;
}

function okResponseRecord(value: unknown, label: string): Record<string, unknown> {
  const result = responseRecord(value, label);
  if (result.ok !== true) throw new BqError(`Malformed ${label} response.`, 200);
  return result;
}

function validCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validateMutationAck(value: unknown, label: string): undefined | { ok: true } {
  // Bunqueue write routes use either an empty 2xx/204 or an explicit {ok:true}.
  if (value === undefined) return;
  const result = okResponseRecord(value, label);
  return result as unknown as { ok: true };
}

export function createServerTargetClient(
  target: ServerRequestTarget,
  lifecycleSignal?: AbortSignal
): ServerTargetClient {
  const captured = serverTargetHeaders.get(target);
  if (!captured) throw new TypeError('Invalid server request target.');
  const headers = { ...captured };
  const at = <T>(path: string, init?: RequestInit, timeoutMs = requestTimeoutMs): Promise<T> => {
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
      const raw = await at<unknown>(`/queues/${queueHttpPathSegment(queue)}/counts`);
      const result = okResponseRecord(raw, 'queue counts');
      const counts = responseRecord(result.counts, 'queue counts');
      if (!Object.values(counts).every(validCount)) {
        throw new BqError('Malformed queue counts response.', 200);
      }
      return { ok: true, counts: counts as Record<string, number> };
    },
    jobsList: async (queue: string, states?: string[], limit = 50, offset = 0) => {
      const search = new URLSearchParams();
      if (states?.length) search.set('states', states.join(','));
      search.set('limit', String(limit));
      search.set('offset', String(offset));
      const raw = await at<unknown>(`/queues/${queueHttpPathSegment(queue)}/jobs/list?${search}`);
      const result = okResponseRecord(raw, 'jobs list');
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
      ) {
        throw new BqError('Malformed jobs list response.', 200);
      }
      return { ok: true as const, jobs: result.jobs as JobFull[] };
    },
    job: async (id: string) => {
      const raw = await at<unknown>(`/jobs/${opaqueHttpPathSegment(id)}`);
      const result = okResponseRecord(raw, 'job');
      const job = responseRecord(result.job, 'job') as unknown as JobFull;
      if (job.id !== id) throw new BqError('Malformed job response.', 200);
      return { ok: true as const, job };
    },
    dlqStats: async (queue: string) => {
      const raw = await at<unknown>(`/queues/${queueHttpPathSegment(queue)}/dlq/stats`);
      const result = okResponseRecord(raw, 'DLQ stats');
      const stats = responseRecord(result.stats, 'DLQ stats') as unknown as DlqStatsFull;
      if (!validCount(stats.total)) throw new BqError('Malformed DLQ stats response.', 200);
      return { ok: true as const, stats };
    },
    dlq: async (queue: string, limit = 100, offset = 0) => {
      const raw = await at<unknown>(
        `/queues/${queueHttpPathSegment(queue)}/dlq?limit=${limit}&offset=${offset}`
      );
      const result = okResponseRecord(raw, 'DLQ list');
      if (!Array.isArray(result.entries) || !validCount(result.total)) {
        throw new BqError('Malformed DLQ list response.', 200);
      }
      for (const entry of result.entries) {
        const candidate = responseRecord(entry, 'DLQ list');
        const job = responseRecord(candidate.job, 'DLQ list');
        if (typeof job.id !== 'string' || job.id.length === 0) {
          throw new BqError('Malformed DLQ list response.', 200);
        }
      }
      return {
        ok: true as const,
        entries: result.entries as DlqEntryFull[],
        total: result.total,
      };
    },
    health: async () => {
      const raw = await call<unknown>(
        target.baseUrl,
        '/health',
        headers,
        lifecycleSignal ? { signal: lifecycleSignal } : undefined,
        false,
        'server',
        [503]
      );
      return responseRecord(raw, 'health') as {
        ok?: boolean;
        version?: string;
      } & Record<string, unknown>;
    },
    stats: async () => {
      const raw = await at<unknown>('/stats');
      const result = okResponseRecord(raw, 'server stats');
      responseRecord(result.stats, 'server stats');
      return raw as StatsResponse;
    },
    workers: async () => parseWorkersPayload(await at<unknown>('/workers')),
    crons: async () => {
      const raw = await at<unknown>('/crons');
      const result = okResponseRecord(raw, 'crons');
      if (
        !Array.isArray(result.crons) ||
        !result.crons.every((candidate) => {
          const cron = candidate as Partial<CronFull> | null;
          return (
            cron !== null &&
            typeof cron === 'object' &&
            !Array.isArray(cron) &&
            typeof cron.name === 'string' &&
            cron.name.length > 0 &&
            typeof cron.queue === 'string' &&
            cron.queue.length > 0
          );
        })
      ) {
        throw new BqError('Malformed crons response.', 200);
      }
      return { ok: true as const, crons: result.crons as CronFull[] };
    },
    addJobsBulk: async (queue: string, jobs: BulkJobBody[]) => {
      assertBulkJobCount(jobs);
      const requestBody = encodedBulkJobRequest(jobs);
      return at<{ ok: boolean; ids: string[] }>(
        `/queues/${queueHttpPathSegment(queue)}/jobs/bulk`,
        { method: 'POST', body: requestBody },
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
      validateMutationAck(
        await at<unknown>(`/jobs/${opaqueHttpPathSegment(id)}/promote`, body('POST')),
        'promote job'
      ),
    pause: async (queue: string) =>
      validateMutationAck(
        await at<unknown>(`/queues/${queueHttpPathSegment(queue)}/pause`, body('POST')),
        'pause queue'
      ),
    resume: async (queue: string) =>
      validateMutationAck(
        await at<unknown>(`/queues/${queueHttpPathSegment(queue)}/resume`, body('POST')),
        'resume queue'
      ),
    clean: (queue: string, opts: { grace?: number; state?: string; limit?: number } = {}) =>
      at<{ ok: boolean; count: number }>(
        `/queues/${queueHttpPathSegment(queue)}/clean`,
        body('POST', opts)
      ),
  });
}

/** Options applied to the jobs a cron spawns (subset the HTTP route forwards). */
export interface CronJobOptions {
  maxAttempts?: number;
  backoff?: Backoff;
  timeout?: number;
  delay?: number;
  stallTimeout?: number;
  removeOnComplete?: boolean;
  removeOnFail?: boolean;
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
  // Advanced: cap total executions, run once immediately on create, replay a
  // missed run after a restart, and per-spawned-job options.
  maxLimit?: number;
  immediately?: boolean;
  skipMissedOnRestart?: boolean;
  uniqueKey?: string;
  dedup?: DedupOptions;
  jobOptions?: CronJobOptions;
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
  overview: (init?: RequestInit) => srv<OverviewResponse>('/dashboard', init),
  queues: (limit = 500, offset = 0) =>
    srv<QueuesResponse>(`/dashboard/queues?limit=${limit}&offset=${offset}`),
  // All queues' counts (waiting/prioritized/active/completed/failed/delayed + paused) in a
  // single call — replaces per-queue queueDetail fan-outs. Bare array, O(Q)
  // server-side; for very large deployments prefer paginated `queues()`.
  queuesSummary: async () =>
    parseQueueSummaryPayload(await srv<unknown>('/queues/summary')) as QueueSummaryFull[],
  queueDetail: (queue: string, includeJobs = true) =>
    srv<QueueDetailResponse>(
      `/dashboard/queues/${queueHttpPathSegment(queue)}?includeJobs=${includeJobs}`
    ),
  stats: (init?: RequestInit) => srv<StatsResponse>('/stats', init),
  // strict:false — /storage's `ok` is a semantic status flag too (disk-full →
  // ok:false with HTTP 200 is the very data the storage views exist to show),
  // matching api.ts's storage() opt-out.
  storage: () => srv<{ ok: boolean; data: StorageStatusFlat }>('/storage', undefined, false),
  // strict:false — /health's `ok` means "server healthy", not "request succeeded".
  // A disk-full server deliberately answers 503; accept that one status so the
  // Diagnostics UI receives the structured degradation details.
  health: () =>
    srv<{ ok?: boolean; version?: string } & Record<string, unknown>>(
      '/health',
      undefined,
      false,
      [503]
    ),
  ping: () => srv<{ ok: boolean; data: { pong: boolean; time: number } }>('/ping'),
  captureServerRequestTarget,
  createServerTargetClient,
  getJobAtTarget,
  captureAgentRequestTarget,
  getDbRowsAtTarget,
  getDbExportAtTarget,
  // Prometheus scrape URL (the endpoint returns text/plain exposition, not JSON,
  // so this is a URL to hand to a scraper, not a fetch helper).
  prometheusUrl: () => `${getBaseUrl()}/prometheus`,
  // Force GC + compact internal state; returns before/after heap in MB.
  gc: () => srv<{ ok: boolean; before: HeapMB; after: HeapMB }>('/gc', body('POST')),
  // bun:jsc heap breakdown for leak diagnosis (top object types + collection sizes).
  heapStats: () =>
    srv<{
      ok: boolean;
      memory: HeapMB;
      heap: { objectCount: number; protectedCount: number; globalCount: number };
      collections: Record<string, unknown>;
      topObjectTypes: { type: string; count: number }[];
    }>('/heapstats'),

  // ---- Jobs (read) ----
  jobsList: (queue: string, states?: string[], limit = 50, offset = 0) => {
    const sp = new URLSearchParams();
    if (states?.length) sp.set('states', states.join(','));
    sp.set('limit', String(limit));
    sp.set('offset', String(offset));
    return srv<{ ok: boolean; jobs: JobFull[] }>(
      `/queues/${queueHttpPathSegment(queue)}/jobs/list?${sp}`
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

  // ---- Jobs (write) ----
  addJob: async (queue: string, b: AddJobBody) => {
    const requestBody = encodedAddJobRequest(b);
    return srv<{ ok: boolean; id: string }>(`/queues/${queueHttpPathSegment(queue)}/jobs`, {
      method: 'POST',
      body: requestBody,
    });
  },
  addJobsBulk: async (queue: string, jobs: BulkJobBody[]) => {
    assertBulkJobCount(jobs);
    const requestBody = encodedBulkJobRequest(jobs);
    return srv<{ ok: boolean; ids: string[] }>(
      `/queues/${queueHttpPathSegment(queue)}/jobs/bulk`,
      { method: 'POST', body: requestBody },
      true,
      [],
      BULK_TIMEOUT_MS
    );
  },
  // Worker-side consume: reserve up to `count` jobs, then ack (complete) them by
  // id. Used by the Benchmark page to simulate workers draining a queue.
  pullBatch: (queue: string, count: number) =>
    srv<{ ok: boolean; jobs: { id: string }[] }>(
      `/queues/${queueHttpPathSegment(queue)}/jobs/pull-batch`,
      body('POST', { count })
    ),
  ackBatch: (ids: string[]) => srv<{ ok: boolean }>('/jobs/ack-batch', body('POST', { ids })),
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
  // Admin-set a job's progress (0–100 + optional message). Also refreshes the
  // stall heartbeat and fires a job.progress webhook. Active jobs only (server
  // returns ok:false otherwise, surfaced as a BqError).
  setJobProgress: (id: string, progress: number, message?: string) =>
    srv(`/jobs/${opaqueHttpPathSegment(id)}/progress`, body('POST', { progress, message })),

  // ---- Queue control ----
  counts: (queue: string) =>
    srv<{ ok: boolean; counts: Record<string, number> }>(
      `/queues/${queueHttpPathSegment(queue)}/counts`
    ),
  pause: (queue: string) => srv(`/queues/${queueHttpPathSegment(queue)}/pause`, body('POST')),
  resume: (queue: string) => srv(`/queues/${queueHttpPathSegment(queue)}/resume`, body('POST')),
  drain: (queue: string) =>
    srv<{ ok: boolean; count: number }>(
      `/queues/${queueHttpPathSegment(queue)}/drain`,
      bulkBody('POST'),
      true,
      [],
      BULK_TIMEOUT_MS
    ),
  obliterate: (queue: string) =>
    srv(
      `/queues/${queueHttpPathSegment(queue)}/obliterate`,
      bulkBody('POST'),
      true,
      [],
      BULK_TIMEOUT_MS
    ),
  clean: (queue: string, opts: { grace?: number; state?: string; limit?: number } = {}) =>
    srv<{ ok: boolean; count: number }>(
      `/queues/${queueHttpPathSegment(queue)}/clean`,
      body('POST', opts)
    ),
  promoteJobs: (queue: string, count?: number) =>
    srv<{ ok: boolean; count: number }>(
      `/queues/${queueHttpPathSegment(queue)}/promote-jobs`,
      body('POST', count != null ? { count } : undefined)
    ),
  retryCompleted: (_queue: string, _id?: string): never => {
    throw new TypeError(
      'Completed-job requeue is unavailable in Bunqueue v2.8.55 because flow dependency registration is not rebuilt.'
    );
  },

  // ---- Limits / config ----
  setRateLimit: (queue: string, limit: number, duration?: number, ttl?: number) =>
    srv(
      `/queues/${queueHttpPathSegment(queue)}/rate-limit`,
      body('PUT', {
        limit,
        ...(duration === undefined ? {} : { duration }),
        ...(ttl === undefined ? {} : { ttl }),
      })
    ),
  clearRateLimit: (queue: string) =>
    srv(`/queues/${queueHttpPathSegment(queue)}/rate-limit`, { method: 'DELETE' }),
  setConcurrency: (queue: string, concurrency: number) =>
    srv(`/queues/${queueHttpPathSegment(queue)}/concurrency`, body('PUT', { concurrency })),
  clearConcurrency: (queue: string) =>
    srv(`/queues/${queueHttpPathSegment(queue)}/concurrency`, { method: 'DELETE' }),
  getStallConfig: (queue: string) =>
    srv<{ ok: boolean; config: StallConfig }>(
      `/queues/${queueHttpPathSegment(queue)}/stall-config`
    ),
  setStallConfig: (queue: string, config: Partial<StallConfig>) =>
    srv(`/queues/${queueHttpPathSegment(queue)}/stall-config`, body('PUT', { config })),
  getDlqConfig: (queue: string) =>
    srv<{ ok: boolean; config: DlqConfig }>(`/queues/${queueHttpPathSegment(queue)}/dlq-config`),
  setDlqConfig: (queue: string, config: Partial<DlqConfig>) => {
    if (config.autoRetry === true) {
      throw new TypeError(
        'DLQ auto-retry is unavailable: Bunqueue v2.8.55 does not rebuild flow dependency registration.'
      );
    }
    if (config.maxAge !== undefined || config.maxEntries !== undefined) {
      throw new TypeError(
        'DLQ retention is read-only: maxAge/maxEntries can destructively expire or evict flow jobs without an atomic dependency check.'
      );
    }
    return srv(`/queues/${queueHttpPathSegment(queue)}/dlq-config`, body('PUT', { config }));
  },

  // ---- DLQ ----
  dlq: (queue: string, limit = 100, offset = 0) =>
    srv<{ ok: boolean; entries: DlqEntryFull[]; total: number }>(
      `/queues/${queueHttpPathSegment(queue)}/dlq?limit=${limit}&offset=${offset}`
    ),
  dlqStats: (queue: string) =>
    srv<{ ok: boolean; stats: DlqStatsFull }>(`/queues/${queueHttpPathSegment(queue)}/dlq/stats`),
  retryDlq: (_queue: string, _jobId?: string): never => {
    throw new TypeError(
      'DLQ retry is unavailable in Bunqueue v2.8.55 because the endpoint has no atomic job-generation, state, or flow-topology precondition.'
    );
  },
  purgeDlq: (queue: string) =>
    srv<{ ok: boolean; count: number }>(
      `/queues/${queueHttpPathSegment(queue)}/dlq/purge`,
      body('POST')
    ),

  // ---- Crons ----
  crons: () => srv<{ ok: boolean; crons: CronFull[] }>('/crons'),
  createCron: (b: CreateCronBody) => srv('/crons', body('POST', b)),
  deleteCron: (name: string) =>
    srv(`/crons/${decodedHttpPathSegment(name, 'Cron name', 256)}`, { method: 'DELETE' }),

  // ---- Webhooks ----
  webhooks: async () => parseWebhooksPayload(await srv<unknown>('/webhooks')),
  addWebhook: (b: AddWebhookBody) => srv('/webhooks', body('POST', b)),
  removeWebhook: (id: string) =>
    srv(`/webhooks/${opaqueHttpPathSegment(id)}`, { method: 'DELETE' }),
  setWebhookEnabled: (id: string, enabled: boolean) =>
    srv(`/webhooks/${opaqueHttpPathSegment(id)}/enabled`, body('PUT', { enabled })),

  // ---- Workers ----
  workers: async () => parseWorkersPayload(await srv<unknown>('/workers')),
  unregisterWorker: (id: string) =>
    srv(`/workers/${opaqueHttpPathSegment(id)}`, { method: 'DELETE' }),

  eventsUrl: (queue?: string) =>
    getBaseUrl() + (queue ? `/events/queues/${eventQueuePathSegment(queue)}` : '/events'),

  // ---- Database inspector (agent-side, read-only SQLite) ----
  db: {
    info: () =>
      agent<{
        ok: boolean;
        sqliteVersion: string;
        pageSize: number;
        pageCount: number;
        journalMode: string;
        freelistPages: number;
        tables: number;
        indexes: number;
        fileSize: number;
        walSize: number;
      }>('/db/info'),
    tables: () =>
      agent<{ ok: boolean; tables: { name: string; rows: number; columns: number }[] }>(
        '/db/tables'
      ),
    schema: (table: string) =>
      agent<{
        ok: boolean;
        table: string;
        columns: {
          name: string;
          type: string;
          notNull: boolean;
          defaultValue: string | null;
          primaryKey: boolean;
        }[];
        indexes: { name: string; unique: boolean; columns: string[] }[];
        sql: string | null;
        rowCount: number;
      }>(`/db/tables/${decodedHttpPathSegment(table, 'Database table')}/schema`),
    rows: (
      table: string,
      limit = 50,
      offset = 0,
      orderBy?: string,
      dir: 'asc' | 'desc' = 'asc',
      filter?: DbFilter
    ) =>
      agent<DbRowsPage>(
        `/db/tables/${decodedHttpPathSegment(table, 'Database table')}?limit=${limit}&offset=${offset}` +
          (orderBy ? `&orderBy=${q(orderBy)}&dir=${dir}` : '') +
          (filter?.value
            ? `&fcol=${q(filter.column)}&fop=${filter.op}&fval=${q(filter.value)}`
            : '')
      ),
    /** Full, untruncated value of one cell, keyed by rowid (detail view). */
    cell: (table: string, rowid: DbRowId, column: string) =>
      agent<{ ok: boolean; value: unknown }>(
        `/db/tables/${decodedHttpPathSegment(table, 'Database table')}/cell?rowid=${q(String(rowid))}&column=${q(column)}`
      ),
    query: (sql: string) =>
      agent<{
        ok: boolean;
        columns: string[];
        rows: unknown[][];
        rowCount: number;
        truncated: boolean;
        ms: number;
      }>('/db/query', body('POST', { sql })),
  },

  // ---- Control agent (process lifecycle) ----
  // Accessor (rather than a writable data property) exposes the validated
  // module-init snapshot without allowing later code to retarget it.
  get agentBase() {
    return AGENT;
  },
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

// Object-literal accessors are configurable by default. Seal this one property
// so the public diagnostic value remains the exact snapshot used by transport.
Object.defineProperty(bq, 'agentBase', { configurable: false });
