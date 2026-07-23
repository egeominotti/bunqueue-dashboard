/**
 * Read-only SQLite inspector backing the dashboard's Database section.
 *
 * Every connection is opened with `{ readonly: true }`, so even a hand-typed
 * query physically cannot mutate the store — SQLite rejects INSERT/UPDATE/DDL
 * with SQLITE_READONLY at the engine level. Connections are opened per request
 * and closed immediately, so the inspector never holds a lock against the
 * running bunqueue server (WAL allows concurrent readers).
 *
 * Defense in depth for the arbitrary-query endpoint (dbQuery):
 *  - a positive statement allowlist rejects ATTACH/DETACH/CREATE-TEMP/etc.
 *    before execution — but it inspects only the FIRST keyword, so it does NOT
 *    stop a trailing statement smuggled in after a legal one. Everything here
 *    must therefore compile SQL through db.query() (one statement, the rest
 *    inert) and never db.run() (executes them all). Do not weaken this comment
 *    into "the allowlist makes the store safe": believing that is what once
 *    turned the dup-column recovery path into an arbitrary file write;
 *  - results are streamed with an early break at MAX_ROWS, so a huge or
 *    row-bomb query can't materialize the whole set in agent memory;
 *  - queryWithTimeout() runs it in a disposable Worker raced against a wall
 *    clock, so an O(N^k) scan can't pin the agent's only thread and freeze the
 *    process-control endpoints (falls back to synchronous run if a Worker can't
 *    be spawned, e.g. inside a compiled single-file binary). The timeout aborts
 *    the response, not the query — a synchronous sqlite3_step never yields to
 *    the terminate() request — so live worker threads are counted and capped by
 *    MAX_CONCURRENT_QUERIES instead of accumulating one pinned core per request.
 */
import { existsSync } from 'node:fs';
import { Database } from 'bun:sqlite';

/** Hard cap on rows returned by any endpoint — bounds payload and memory. */
export const MAX_ROWS = 500;
/** Cell strings longer than this are truncated server-side (payload bound). */
const MAX_CELL = 2000;
/** Full single-cell fetch (detail view) hard cap — bounds one pathological blob. */
const MAX_FULL_CELL = 1_000_000;
/** Wall-clock budget for an arbitrary query before it is aborted. */
export const QUERY_TIMEOUT_MS = 5000;

/** Thrown when the database file does not exist yet (maps to HTTP 404). */
export class MissingDbError extends Error {
  readonly missing = true;
}

export interface DbTableInfo {
  name: string;
  rows: number;
  columns: number;
}

export interface DbFilter {
  column: string;
  op: 'contains' | 'eq' | 'ne';
  value: string;
}

export interface DbRowsPage {
  table: string;
  columns: string[];
  rows: unknown[][];
  /** rowid per row (null for WITHOUT ROWID tables) — keys the full-cell fetch. */
  rowids: (number | null)[];
  /** Which cells were truncated server-side, so the UI can flag them. */
  truncatedCells: boolean[][];
  total: number;
  limit: number;
  offset: number;
  orderBy: string | null;
  dir: 'asc' | 'desc';
  filter: DbFilter | null;
}

export interface DbColumnInfo {
  name: string;
  type: string;
  notNull: boolean;
  defaultValue: string | null;
  primaryKey: boolean;
}

export interface DbIndexInfo {
  name: string;
  unique: boolean;
  columns: string[];
}

export interface DbTableSchema {
  table: string;
  columns: DbColumnInfo[];
  indexes: DbIndexInfo[];
  /** Original CREATE TABLE statement from sqlite_master. */
  sql: string | null;
  rowCount: number;
}

export interface DbInfo {
  sqliteVersion: string;
  pageSize: number;
  pageCount: number;
  journalMode: string;
  freelistPages: number;
  tables: number;
  indexes: number;
  fileSize: number;
  walSize: number;
}

export interface DbQueryResult {
  columns: string[];
  rows: unknown[][];
  /** Row count actually returned. A lower bound (">= this") when `truncated`. */
  rowCount: number;
  truncated: boolean;
  ms: number;
}

function open(path: string): Database {
  // Distinguish "file missing" (expected before first server start → 404) from
  // "file present but unreadable/corrupt" (a real error → 400/500).
  try {
    if (!Bun.file(path).size && !existsSync(path)) {
      throw new MissingDbError(
        `Database not found at "${path}" — start the server once to create it.`
      );
    }
  } catch (e) {
    if (e instanceof MissingDbError) throw e;
    // Bun.file().size can throw on some paths; fall through to the open attempt.
  }
  try {
    return new Database(path, { readonly: true });
  } catch (e) {
    if (!existsSync(path)) {
      throw new MissingDbError(
        `Database not found at "${path}" — start the server once to create it.`
      );
    }
    throw new Error(`Could not open database: ${(e as Error).message}`);
  }
}

/** Quote an identifier for SQLite ("" escapes embedded quotes). */
const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** True when a value is over the cell truncation bound. */
function isTruncated(v: unknown): boolean {
  return (v instanceof Uint8Array && v.byteLength > 0) || (typeof v === 'string' && v.length > MAX_CELL);
}

/** JSON-safe cell: BLOBs become a marker, long strings are truncated. */
function cell(v: unknown): unknown {
  if (v instanceof Uint8Array) return `<blob ${v.byteLength} B>`;
  if (typeof v === 'string' && v.length > MAX_CELL) return `${v.slice(0, MAX_CELL)}…`;
  // Read statements run with safeIntegers, so INTEGERs arrive as bigint: keep the
  // familiar number shape when it round-trips exactly, and fall back to a string
  // beyond 2^53 (where a double would silently round the stored value).
  if (typeof v === 'bigint') return bigintCell(v);
  return v;
}

/** Exact-value-preserving JSON form of a SQLite INTEGER read with safeIntegers. */
function bigintCell(v: bigint): number | string {
  return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(v)
    : v.toString();
}

/**
 * bun:sqlite exposes Statement.safeIntegers() at runtime but does not type it.
 * Enabled per statement (never connection-wide) so the COUNT(*) reads that are
 * consumed as numbers keep returning numbers.
 */
function safeIntegers(stmt: unknown): void {
  (stmt as { safeIntegers?: (on: boolean) => void }).safeIntegers?.(true);
}

const sanitize = (rows: unknown[][]): unknown[][] => rows.map((r) => r.map(cell));

/** All user tables with row + column counts. */
export function dbTables(path: string): DbTableInfo[] {
  const db = open(path);
  try {
    const tables = db
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all() as { name: string }[];
    return tables.map(({ name }) => {
      const { c } = db.query(`SELECT COUNT(*) AS c FROM ${ident(name)}`).get() as { c: number };
      const cols = db.query(`PRAGMA table_info(${ident(name)})`).all();
      return { name, rows: c, columns: cols.length };
    });
  } finally {
    db.close();
  }
}

/** Resolve a caller-supplied table name against sqlite_master (identifier allowlist). */
function knownTable(db: Database, table: string): string {
  const known = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { name: string } | null;
  if (!known) throw new Error(`No such table: ${table}`);
  return known.name;
}

/** Build a validated WHERE clause + bound param for a browse filter (never interpolates the value). */
function buildFilter(
  columns: string[],
  filter: DbFilter | undefined
): { clause: string; params: unknown[]; applied: DbFilter | null } {
  if (!filter || !filter.value) return { clause: '', params: [], applied: null };
  const col = columns.find((c) => c === filter.column);
  if (!col) throw new Error(`No such column: ${filter.column}`);
  const q = ident(col);
  if (filter.op === 'eq') return { clause: ` WHERE ${q} = ?`, params: [filter.value], applied: filter };
  if (filter.op === 'ne') return { clause: ` WHERE ${q} <> ?`, params: [filter.value], applied: filter };
  // contains (default) — escape LIKE metacharacters so a value containing % or _
  // matches literally instead of turning into a wildcard pattern.
  const needle = filter.value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
  return {
    clause: ` WHERE ${q} LIKE ? ESCAPE '\\'`,
    params: [`%${needle}%`],
    applied: { ...filter, op: 'contains' },
  };
}

/**
 * One page of a table's rows. Table, orderBy and filter-column identifiers are
 * validated against sqlite_master / table_info — never interpolated from raw
 * input; the filter value is always bound as a parameter.
 */
export function dbRows(
  path: string,
  table: string,
  limit: number,
  offset: number,
  orderBy?: string,
  dir: 'asc' | 'desc' = 'asc',
  filter?: DbFilter
): DbRowsPage {
  const lim = Math.max(1, Math.min(MAX_ROWS, Math.floor(limit) || 50));
  // Non-finite / out-of-range offsets must be clamped here: SQLite rejects a
  // bound non-safe-integer double with a raw "datatype mismatch".
  const off = Number.isFinite(offset)
    ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(offset) || 0))
    : 0;
  const db = open(path);
  try {
    const name = knownTable(db, table);
    const columns = (db.query(`PRAGMA table_info(${ident(name)})`).all() as { name: string }[]).map(
      (c) => c.name
    );

    let order = '';
    let sortCol: string | null = null;
    if (orderBy) {
      sortCol = columns.find((c) => c === orderBy) ?? null;
      if (!sortCol) throw new Error(`No such column: ${orderBy}`);
      order = ` ORDER BY ${ident(sortCol)} ${dir === 'desc' ? 'DESC' : 'ASC'}`;
    }

    const { clause, params, applied } = buildFilter(columns, filter);

    const { c: total } = db
      .query(`SELECT COUNT(*) AS c FROM ${ident(name)}${clause}`)
      .get(...(params as [])) as { c: number };

    // Prefer selecting rowid so the detail view can fetch untruncated cells;
    // WITHOUT ROWID tables have no rowid column — fall back to a plain select.
    let rowids: (number | null)[] = [];
    let rawRows: unknown[][];
    try {
      const stmt = db.query(
        `SELECT rowid AS __rid, * FROM ${ident(name)}${clause}${order} LIMIT ? OFFSET ?`
      );
      safeIntegers(stmt);
      const withRowid = stmt.values(...(params as []), lim, off) as unknown[][];
      rowids = withRowid.map((r) =>
        typeof r[0] === 'bigint' ? Number(r[0]) : typeof r[0] === 'number' ? r[0] : null
      );
      rawRows = withRowid.map((r) => r.slice(1));
    } catch {
      const stmt = db.query(`SELECT * FROM ${ident(name)}${clause}${order} LIMIT ? OFFSET ?`);
      safeIntegers(stmt);
      rawRows = stmt.values(...(params as []), lim, off) as unknown[][];
      rowids = rawRows.map(() => null);
    }

    const truncatedCells = rawRows.map((r) => r.map(isTruncated));
    return {
      table: name,
      columns,
      rows: sanitize(rawRows),
      rowids,
      truncatedCells,
      total,
      limit: lim,
      offset: off,
      orderBy: sortCol,
      dir: dir === 'desc' ? 'desc' : 'asc',
      filter: applied,
    };
  } finally {
    db.close();
  }
}

/** Full, untruncated value of a single cell, keyed by rowid (for the detail view). */
export function dbCell(path: string, table: string, rowid: number, column: string): { value: unknown } {
  const db = open(path);
  try {
    const name = knownTable(db, table);
    const columns = (db.query(`PRAGMA table_info(${ident(name)})`).all() as { name: string }[]).map(
      (c) => c.name
    );
    const col = columns.find((c) => c === column);
    if (!col) throw new Error(`No such column: ${column}`);
    const stmt = db.query(`SELECT ${ident(col)} AS v FROM ${ident(name)} WHERE rowid = ?`);
    safeIntegers(stmt);
    const row = stmt.get(rowid) as { v: unknown } | null;
    if (!row) throw new Error('Row not found');
    let v = row.v;
    if (v instanceof Uint8Array) v = `<blob ${v.byteLength} B — binary, not shown>`;
    else if (typeof v === 'bigint') v = bigintCell(v);
    else if (typeof v === 'string' && v.length > MAX_FULL_CELL) v = `${v.slice(0, MAX_FULL_CELL)}…`;
    return { value: v };
  } finally {
    db.close();
  }
}

/** Column definitions, indexes and original DDL for one table. */
export function dbSchema(path: string, table: string): DbTableSchema {
  const db = open(path);
  try {
    const name = knownTable(db, table);
    const columns = (
      db.query(`PRAGMA table_info(${ident(name)})`).all() as {
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }[]
    ).map((c) => ({
      name: c.name,
      type: c.type || 'ANY',
      notNull: c.notnull === 1,
      defaultValue: c.dflt_value,
      primaryKey: c.pk > 0,
    }));
    const indexes = (
      db.query(`PRAGMA index_list(${ident(name)})`).all() as { name: string; unique: number }[]
    ).map((ix) => ({
      name: ix.name,
      unique: ix.unique === 1,
      columns: (db.query(`PRAGMA index_info(${ident(ix.name)})`).all() as { name: string }[]).map(
        (c) => c.name
      ),
    }));
    const master = db
      .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) as { sql: string | null } | null;
    const { c: rowCount } = db.query(`SELECT COUNT(*) AS c FROM ${ident(name)}`).get() as {
      c: number;
    };
    return { table: name, columns, indexes, sql: master?.sql ?? null, rowCount };
  } finally {
    db.close();
  }
}

/** Store-level metadata: engine version, pragmas, object counts, on-disk size. */
export function dbInfo(path: string): DbInfo {
  const db = open(path);
  try {
    const one = (sql: string) => (db.query(sql).values()[0] as unknown[])[0];
    const count = (type: string) =>
      (
        db
          .query(
            "SELECT COUNT(*) AS c FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%'"
          )
          .get(type) as { c: number }
      ).c;
    const size = (p: string) => {
      try {
        return Bun.file(p).size || 0;
      } catch {
        return 0;
      }
    };
    return {
      sqliteVersion: String(one('SELECT sqlite_version()')),
      pageSize: Number(one('PRAGMA page_size')),
      pageCount: Number(one('PRAGMA page_count')),
      journalMode: String(one('PRAGMA journal_mode')),
      freelistPages: Number(one('PRAGMA freelist_count')),
      tables: count('table'),
      indexes: count('index'),
      fileSize: size(path),
      walSize: size(`${path}-wal`),
    };
  } finally {
    db.close();
  }
}

/** Leading keyword of a statement, ignoring leading whitespace/comments. */
function leadingKeyword(sql: string): string {
  const head = sql.replace(/^(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)*/, '');
  return head.slice(0, 12).toUpperCase();
}

const READ_ONLY_LEAD = /^(?:SELECT|WITH|EXPLAIN|VALUES|PRAGMA)\b/;

/** Temp-view name used to recover colliding output column names (see dbQuery). */
const DUP_VIEW = '__bq_query_columns';

/**
 * Re-prepare a statement whose output column names collide through a TEMP VIEW,
 * so SQLite disambiguates them itself ("id", "id:1") and every column survives
 * the by-name row rebuild. The view lives in the private temp schema (nothing is
 * written to the readonly store) and dies with the connection. Returns null when
 * the statement can't be a view (PRAGMA / EXPLAIN — neither can collide anyway).
 */
function disambiguateColumns(
  db: Database,
  sql: string
): { stmt: ReturnType<Database['query']>; cols: string[] } | null {
  try {
    // MUST be query().run() (single prepared statement), never db.run(): db.run
    // executes EVERY statement in the string, and the front-door allowlist only
    // inspects the FIRST keyword. `SELECT 1 a, 2 a; VACUUM INTO '/tmp/x'` would
    // otherwise reach a readonly connection as an arbitrary-file WRITE, and
    // `…; ATTACH '/any.db' AS l; DROP VIEW …; CREATE TEMP VIEW … AS SELECT * FROM l.x`
    // as an arbitrary-SQLite-file READ. query() compiles only the first
    // statement, so the trailing payload is inert.
    db.query(`CREATE TEMP VIEW ${ident(DUP_VIEW)} AS ${sql.replace(/;\s*$/, '')}`).run();
    const cols = (
      db.query(`PRAGMA table_info(${ident(DUP_VIEW)})`).all() as { name: string }[]
    ).map((c) => c.name);
    return { stmt: db.query(`SELECT * FROM ${ident(DUP_VIEW)}`), cols };
  } catch {
    return null;
  }
}

/**
 * Run an arbitrary read-only query. Rejects non-read statements up front,
 * streams rows with an early break at MAX_ROWS, and translates the raw SQLite
 * read-only error into a friendly message. Synchronous + pure (see
 * queryWithTimeout for the off-thread, time-boxed wrapper the route uses).
 */
export function dbQuery(path: string, sql: string): DbQueryResult {
  const trimmed = sql.trim();
  if (!trimmed) throw new Error('Empty query');
  if (!READ_ONLY_LEAD.test(leadingKeyword(trimmed))) {
    throw new Error('Only read-only SELECT / WITH / EXPLAIN / VALUES / PRAGMA queries are allowed here.');
  }
  const db = open(path);
  try {
    const started = performance.now();
    let stmt: ReturnType<Database['query']>;
    try {
      stmt = db.query(trimmed);
    } catch (e) {
      throw translateError(e);
    }
    let cols = stmt.columnNames;
    // Bun de-duplicates columnNames while columnTypes keeps the true arity, and
    // rows are rebuilt BY NAME below — so without this, a statement with colliding
    // output names (`SELECT a.id, b.id`, any self-join) silently loses columns.
    if (stmt.columnTypes.length > cols.length) {
      const wide = disambiguateColumns(db, trimmed);
      if (wide) {
        stmt = wide.stmt;
        cols = wide.cols;
      }
    }
    safeIntegers(stmt);
    const rows: unknown[][] = [];
    let truncated = false;
    try {
      // Rebuild positional arrays from the object iterator so memory is bounded
      // to MAX_ROWS regardless of the query's true cardinality.
      for (const row of stmt.iterate() as IterableIterator<Record<string, unknown>>) {
        if (rows.length >= MAX_ROWS) {
          truncated = true;
          break;
        }
        rows.push(cols.map((c) => (row as Record<string, unknown>)[c]));
      }
    } catch (e) {
      throw translateError(e);
    }
    const ms = performance.now() - started;
    return {
      columns: cols,
      rows: sanitize(rows),
      rowCount: rows.length,
      truncated,
      ms: Math.round(ms * 10) / 10,
    };
  } finally {
    db.close();
  }
}

function translateError(e: unknown): Error {
  const msg = String((e as Error)?.message ?? e);
  if (/readonly|read-only|SQLITE_READONLY/i.test(msg)) {
    return new Error('Connection is read-only — INSERT / UPDATE / DELETE / DDL are not permitted here.');
  }
  return e instanceof Error ? e : new Error(msg);
}

/**
 * Time-boxed, off-thread execution of an arbitrary query. Spawns a disposable
 * readonly Worker and races it against QUERY_TIMEOUT_MS so a runaway scan can't
 * freeze the agent's control endpoints.
 *
 * The timeout aborts the RESPONSE, not the query: terminate() is delivered to
 * the worker's event loop, which a synchronous sqlite3_step never yields back
 * to, so a runaway scan keeps burning its own thread until SQLite finishes it.
 * That thread is therefore accounted for (a slot is held until the worker really
 * exits) and capped by MAX_CONCURRENT_QUERIES, so N timed-out queries can pin at
 * most MAX_CONCURRENT_QUERIES cores instead of one core per request, forever.
 */
let queryWorkerUrl = new URL('./dbQueryWorker.ts', import.meta.url).href;

/** Hard cap on query worker threads alive at once (see queryWithTimeout). */
export const MAX_CONCURRENT_QUERIES = 2;
let liveQueryWorkers = 0;

/** Query worker threads currently alive — includes timed-out, still-running ones. */
export const queryWorkerLoad = (): number => liveQueryWorkers;

/**
 * The standalone executable's bundle root is scripts/serve.ts, so it supplies
 * the embedded worker URL relative to that entrypoint. Source-mode agent runs
 * keep the module-relative default above.
 */
export function setQueryWorkerUrl(url: string): void {
  queryWorkerUrl = url;
}

const spawnRealWorker = (): Worker => new Worker(queryWorkerUrl, { type: 'module' });
let queryWorkerFactory: () => Worker = spawnRealWorker;

/**
 * Swap how a query worker is constructed. Tests only: spawning a real Bun
 * Worker in a process where happy-dom's globals are installed panics the
 * runtime (allocator abort), so the timeout/accounting behaviour below is
 * exercised through a stand-in worker instead of a real thread. Pass null to
 * restore the real one.
 */
export function setQueryWorkerFactory(factory: (() => Worker) | null): void {
  queryWorkerFactory = factory ?? spawnRealWorker;
}

export async function queryWithTimeout(path: string, sql: string): Promise<DbQueryResult> {
  if (liveQueryWorkers >= MAX_CONCURRENT_QUERIES) {
    throw new Error(
      `Too many queries running (${liveQueryWorkers}/${MAX_CONCURRENT_QUERIES}). A previous query timed out and is still running inside SQLite — wait for it to finish, or restart the agent.`
    );
  }
  let worker: Worker;
  try {
    worker = queryWorkerFactory();
  } catch (e) {
    throw new Error(`Query worker unavailable: ${(e as Error).message ?? String(e)}`);
  }
  liveQueryWorkers++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    liveQueryWorkers--;
  };
  // A worker that never answers still holds its slot until the thread really
  // exits ('close' fires when SQLite finally returns) — that is the whole point.
  worker.addEventListener('close', release);
  try {
    return await new Promise<DbQueryResult>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        worker.terminate();
        reject(
          new Error(
            `Query exceeded the ${QUERY_TIMEOUT_MS / 1000}s time limit and was abandoned (it may keep running inside SQLite until it completes).`
          )
        );
      }, QUERY_TIMEOUT_MS);
      worker.addEventListener('message', (ev: MessageEvent) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // The query is done — its thread is idle, so free the slot immediately.
        release();
        const d = ev.data as {
          ok: boolean;
          result?: DbQueryResult;
          error?: string;
          missing?: boolean;
        };
        if (d.ok && d.result) resolve(d.result);
        // The worker boundary is a string channel, so the error CLASS is carried
        // as a flag — server.ts maps MissingDbError to 404, everything else 400.
        else if (d.missing) reject(new MissingDbError(d.error ?? 'Database not found'));
        else reject(new Error(d.error ?? 'Query failed'));
      });
      worker.addEventListener('error', (ev: ErrorEvent) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        release();
        ev.preventDefault?.();
        reject(new Error(`Query worker failed: ${ev.message || 'unknown worker error'}`));
      });
      worker.postMessage({ path, sql });
    });
  } finally {
    worker.terminate();
  }
}
