import { decodedHttpPathSegment } from '../upstreamPaths';
import { type AgentRequestTarget, agentHeadersFor, BqError, call } from './transport';
import type { DbCsvExportResult, DbExportRequest, DbFilter, DbRowsPage } from './types';

export const DB_EXPORT_MAX_ROWS = 200_000;
export const DB_EXPORT_MAX_BYTES = 16 * 1024 * 1024;
const DB_EXPORT_TIMEOUT_MS = 120_000;
const DB_EXPORT_ERROR_MAX_BYTES = 64 * 1024;
const q = encodeURIComponent;

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
  const result = await call<DbRowsPage>(
    target.baseUrl,
    `/db/tables/${decodedHttpPathSegment(table, 'Database table')}?limit=${limit}&offset=${offset}${
      orderBy ? `&orderBy=${q(orderBy)}&dir=${dir}` : ''
    }${filter?.value ? `&fcol=${q(filter.column)}&fop=${filter.op}&fval=${q(filter.value)}` : ''}`,
    { ...agentHeadersFor(target) },
    signal ? { signal } : undefined,
    true,
    'agent'
  );
  signal?.throwIfAborted();
  return result;
}

function integerHeader(headers: Headers, name: string, maximum: number, allowZero = true): number {
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

async function smallErrorBody(response: Response): Promise<string> {
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

async function exactBody(
  response: Response,
  expectedBytes: number,
  signal?: AbortSignal
): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.body)
    throw new BqError('Malformed database export response: missing CSV body.', 200);
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

function exportSnapshot(requested: Readonly<DbExportRequest>): Readonly<DbExportRequest> {
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
  const filter = requested.filter;
  if (
    filter &&
    (typeof filter !== 'object' ||
      Array.isArray(filter) ||
      typeof filter.column !== 'string' ||
      !filter.column ||
      typeof filter.value !== 'string' ||
      !filter.value ||
      !['contains', 'eq', 'ne'].includes(filter.op))
  )
    throw new TypeError('Invalid database export filter.');
  return Object.freeze({
    table: requested.table,
    orderBy: requested.orderBy,
    dir: requested.dir,
    filter: filter ? Object.freeze({ ...filter }) : undefined,
  });
}

async function responseError(
  response: Response,
  target: AgentRequestTarget,
  headers: Record<string, string>
) {
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
  const text = await smallErrorBody(response);
  if (text) {
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      if (typeof parsed?.error === 'string') message = parsed.error;
    } catch {
      // Preserve the status fallback.
    }
  }
  return new BqError(message, response.status);
}

export async function getDbExportAtTarget(
  target: AgentRequestTarget,
  requested: Readonly<DbExportRequest>,
  signal?: AbortSignal
): Promise<DbCsvExportResult> {
  signal?.throwIfAborted();
  const headers = { ...agentHeadersFor(target) };
  const snapshot = exportSnapshot(requested);
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
  try {
    const response = await fetch(target.baseUrl + path, { headers, signal: requestSignal });
    if (!response.ok) throw await responseError(response, target, headers);
    if (response.headers.get('X-Bunqueue-Db-Export-Version') !== '1') {
      throw new BqError('Malformed database export response: unsupported contract version.', 200);
    }
    if (!/^text\/csv(?:;|$)/i.test(response.headers.get('Content-Type') ?? '')) {
      throw new BqError('Malformed database export response: expected CSV content.', 200);
    }
    let responseTable: string;
    try {
      const encoded = response.headers.get('X-Bunqueue-Db-Export-Table');
      if (!encoded) throw new Error('missing');
      responseTable = decodeURIComponent(encoded);
    } catch {
      throw new BqError('Malformed database export response: invalid table identity.', 200);
    }
    if (responseTable !== snapshot.table) {
      throw new BqError(
        `Database export target changed: requested "${snapshot.table}", received "${responseTable}".`,
        200
      );
    }
    const rowCount = integerHeader(
      response.headers,
      'X-Bunqueue-Db-Export-Rows',
      DB_EXPORT_MAX_ROWS
    );
    const bytes = integerHeader(
      response.headers,
      'X-Bunqueue-Db-Export-Bytes',
      DB_EXPORT_MAX_BYTES,
      false
    );
    const length = integerHeader(response.headers, 'Content-Length', DB_EXPORT_MAX_BYTES, false);
    if (length !== bytes)
      throw new BqError(
        'Malformed database export response: Content-Length does not match X-Bunqueue-Db-Export-Bytes.',
        200
      );
    const cap = response.headers.get('X-Bunqueue-Db-Export-Cap');
    if (cap !== 'none' && cap !== 'rows' && cap !== 'bytes') {
      throw new BqError('Malformed database export response: invalid export cap.', 200);
    }
    if (cap === 'rows' && rowCount !== DB_EXPORT_MAX_ROWS) {
      throw new BqError('Malformed database export response: inconsistent row cap.', 200);
    }
    const content = await exactBody(response, bytes, requestSignal);
    signal?.throwIfAborted();
    return { table: responseTable, content, rowCount, bytes, cap: cap === 'none' ? null : cap };
  } catch (error) {
    if (deadline.aborted && !signal?.aborted) throw new BqError('Database export timed out', 0);
    throw error;
  }
}
