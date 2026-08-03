import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useConnectionStore } from '@/components/dashboard/stores/connectionStore';
import {
  mayRestoreModalFocus,
  useGlobalModalStore,
} from '@/components/dashboard/stores/globalModalStore';
import { toast } from '@/components/dashboard/stores/toastStore';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { CopyButton } from '@/components/ui/CopyButton';
import { EmptyState, ErrorState, LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { Select } from '@/components/ui/form';
import { IconClose, IconSearch } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { StatCard } from '@/components/ui/StatCard';
import {
  type AgentRequestTarget,
  BqError,
  bq,
  DB_EXPORT_MAX_BYTES,
  type DbCsvExportResult,
  type DbExportRequest,
  type DbFilter,
  type DbRowsPage,
} from '@/lib/bq';
import { cn } from '@/lib/cn';
import { formatBytes, formatNumber } from '@/lib/format';
import { usePolledData } from '@/lib/usePolledData';

const PAGE_SIZE = 50;
const HISTORY_KEY = 'bq-dash-db-history';
const HISTORY_MAX = 10;
const HISTORY_ENTRY_MAX = 20_000;
const HISTORY_SCAN_MAX = 100;

type Sort = { col: string; dir: 'asc' | 'desc' } | null;
type Tab = 'data' | 'schema';
type ColMeta = Record<string, { type: string; primaryKey: boolean }>;

/* ---------------------------------- utils ---------------------------------- */

export function csvEscape(v: unknown): string {
  const s = v == null ? '' : String(v);
  // Neutralize spreadsheet formula injection on TEXT cells only (a real number
  // can't be a formula, so it keeps numeric fidelity) — mirrors lib/exportFile.ts.
  // A string cell starting with = + - @ (or a leading tab/CR, which Excel strips
  // before evaluating what follows) is executed by Excel/Sheets on open; prefix
  // with a ' so it stays literal text.
  const safe = typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : s;
  // Quote on comma, quote, CR, or LF — a bare \r is a record separator to
  // RFC-4180 parsers and would otherwise split the row.
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}
export function toCsv(columns: string[], rows: unknown[][]): string {
  return [columns.map(csvEscape).join(','), ...rows.map((r) => r.map(csvEscape).join(','))].join(
    '\n'
  );
}
export function download(name: string, mime: string, content: BlobPart) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  // Attach before clicking (Firefox ignores a click on a detached anchor) and
  // revoke on the next tick — revoking in the same task can kill the download
  // before the browser has read the blob.
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
/** Bound and deduplicate untrusted localStorage before it reaches the DOM. */
export function sanitizeQueryHistory(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const clean: string[] = [];
  const seen = new Set<string>();
  for (const entry of value.slice(0, HISTORY_SCAN_MAX)) {
    if (
      typeof entry !== 'string' ||
      entry.length === 0 ||
      entry.length > HISTORY_ENTRY_MAX ||
      seen.has(entry)
    ) {
      continue;
    }
    seen.add(entry);
    clean.push(entry);
    if (clean.length === HISTORY_MAX) break;
  }
  return clean;
}

function loadHistory(): string[] {
  try {
    const h = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]');
    return sanitizeQueryHistory(h);
  } catch {
    return [];
  }
}
function writeHistory(next: string[]): string[] {
  const safe = sanitizeQueryHistory(next);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(safe));
  } catch {
    /* storage full/unavailable — history is a convenience only */
  }
  return safe;
}
function pushHistory(sql: string): string[] {
  return writeHistory([sql, ...loadHistory().filter((h) => h !== sql)].slice(0, HISTORY_MAX));
}
/** Pretty-print a value, expanding JSON strings; used by the detail drawer. */
export function pretty(v: unknown): string {
  if (v == null) return 'NULL';
  const s = typeof v === 'string' ? v : String(v);
  // Only expand embedded JSON objects/arrays. Round-tripping every string would
  // rewrite scalar cells the inspector must show verbatim ('1.50' → '1.5',
  // a 20-digit id → a lossy float): an inspector never alters the stored value.
  const t = s.trimStart();
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      return JSON.stringify(JSON.parse(s), null, 2);
    } catch {
      return s;
    }
  }
  return s;
}

export type DbExportSnapshot = DbExportRequest;
export type DbExportResult = DbCsvExportResult;

/**
 * Load a CSV snapshot through one captured agent URL/credential and one frozen
 * table/sort/filter identity. The agent performs the entire export in a single
 * SQLite read transaction; there is no client pagination to mix snapshots.
 */
export async function collectTableExport(
  requested: DbExportSnapshot,
  target: AgentRequestTarget = bq.captureAgentRequestTarget(),
  signal?: AbortSignal
): Promise<DbExportResult> {
  const snapshot: DbExportSnapshot = Object.freeze({
    table: requested.table,
    orderBy: requested.orderBy,
    dir: requested.dir,
    filter: requested.filter ? Object.freeze({ ...requested.filter }) : undefined,
  });
  return bq.getDbExportAtTarget(target, snapshot, signal);
}

export interface DbRowsIdentity {
  table: string;
  limit: number;
  offset: number;
  orderBy?: string;
  dir: 'asc' | 'desc';
  filter?: DbFilter;
}

const sameFilter = (actual: DbFilter | null, expected?: DbFilter) =>
  expected
    ? actual?.column === expected.column &&
      actual.op === expected.op &&
      actual.value === expected.value
    : actual === null;

export function dbRowsMatchIdentity(page: DbRowsPage, expected: DbRowsIdentity): boolean {
  return (
    page.table === expected.table &&
    page.limit === expected.limit &&
    page.offset === expected.offset &&
    page.orderBy === (expected.orderBy ?? null) &&
    page.dir === expected.dir &&
    sameFilter(page.filter, expected.filter)
  );
}

const MIN_SQLITE_INTEGER = -(1n << 63n);
const MAX_SQLITE_INTEGER = (1n << 63n) - 1n;

function validRowid(value: unknown): value is number | string | null {
  if (value === null) return true;
  if (typeof value === 'number') return Number.isSafeInteger(value);
  if (typeof value !== 'string' || !/^-?(?:0|[1-9]\d*)$/.test(value) || value.length > 20) {
    return false;
  }
  try {
    const integer = BigInt(value);
    return integer >= MIN_SQLITE_INTEGER && integer <= MAX_SQLITE_INTEGER;
  } catch {
    return false;
  }
}

const validDbCell = (value: unknown) =>
  value === null ||
  typeof value === 'string' ||
  (typeof value === 'number' && Number.isFinite(value));

/**
 * Validate every field used by the database grid before rendering. Identity is
 * part of the payload contract, not a best-effort UI check: a response for a
 * different table/page/sort/filter is rejected like any other malformed 2xx.
 */
export function parseDbRowsResponse(value: unknown, expected: DbRowsIdentity): DbRowsPage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Malformed database rows response.');
  }
  const result = value as Record<string, unknown>;
  const columns = result.columns;
  const rows = result.rows;
  const rowids = result.rowids;
  const truncatedCells = result.truncatedCells;
  const filter = result.filter;
  const filterValid =
    filter === null ||
    (filter !== null &&
      typeof filter === 'object' &&
      !Array.isArray(filter) &&
      typeof (filter as Record<string, unknown>).column === 'string' &&
      ((filter as Record<string, unknown>).op === 'contains' ||
        (filter as Record<string, unknown>).op === 'eq' ||
        (filter as Record<string, unknown>).op === 'ne') &&
      typeof (filter as Record<string, unknown>).value === 'string');

  if (
    result.ok !== true ||
    typeof result.table !== 'string' ||
    !Array.isArray(columns) ||
    columns.length === 0 ||
    columns.length > 2000 ||
    columns.some((column) => typeof column !== 'string' || !column) ||
    new Set(columns).size !== columns.length ||
    !Array.isArray(rows) ||
    rows.length > expected.limit ||
    rows.some(
      (row) =>
        !Array.isArray(row) ||
        row.length !== columns.length ||
        row.some((cell) => !validDbCell(cell))
    ) ||
    !Array.isArray(rowids) ||
    rowids.length !== rows.length ||
    rowids.some((rowid) => !validRowid(rowid)) ||
    !Array.isArray(truncatedCells) ||
    truncatedCells.length !== rows.length ||
    truncatedCells.some(
      (row) =>
        !Array.isArray(row) ||
        row.length !== columns.length ||
        row.some((cell) => typeof cell !== 'boolean')
    ) ||
    !Number.isSafeInteger(result.total) ||
    (result.total as number) < 0 ||
    !Number.isSafeInteger(result.limit) ||
    !Number.isSafeInteger(result.offset) ||
    (result.offset as number) < 0 ||
    (result.orderBy !== null && typeof result.orderBy !== 'string') ||
    (result.dir !== 'asc' && result.dir !== 'desc') ||
    !filterValid
  ) {
    throw new Error('Malformed database rows response.');
  }

  const page = {
    ok: true,
    table: result.table,
    columns: [...(columns as string[])],
    rows: (rows as unknown[][]).map((row) => [...row]),
    rowids: [...(rowids as (number | string | null)[])],
    truncatedCells: (truncatedCells as boolean[][]).map((row) => [...row]),
    total: result.total as number,
    limit: result.limit as number,
    offset: result.offset as number,
    orderBy: result.orderBy as string | null,
    dir: result.dir as 'asc' | 'desc',
    filter: filter === null ? null : ({ ...(filter as DbFilter) } satisfies DbFilter),
  } satisfies DbRowsPage;

  if (!dbRowsMatchIdentity(page, expected)) {
    throw new Error(
      `Database rows identity mismatch: requested table "${expected.table}" at offset ${expected.offset}.`
    );
  }
  const expectedRows = Math.min(page.limit, Math.max(0, page.total - page.offset));
  if (page.rows.length !== expectedRows) {
    throw new Error(
      'Malformed database rows response: row count does not match pagination metadata.'
    );
  }
  return page;
}

export interface DbDetailSelection {
  index: number;
  table: string;
  columns: string[];
  row: unknown[];
  rowid: number | string | null;
  truncated: boolean[];
}

/** Capture the exact validated row shown when the operator opens the drawer. */
export function createDbDetailSelection(page: DbRowsPage, index: number): DbDetailSelection | null {
  const row = page.rows[index];
  const truncated = page.truncatedCells[index];
  const rowid = page.rowids[index];
  if (!row || !truncated || rowid === undefined || index < 0) return null;
  return {
    index,
    table: page.table,
    columns: [...page.columns],
    row: [...row],
    rowid,
    truncated: [...truncated],
  };
}

const sameArray = (left: readonly unknown[], right: readonly unknown[]) =>
  left.length === right.length && left.every((value, index) => Object.is(value, right[index]));

/**
 * A poll may replace or shift the positional row while a drawer is open. Keep
 * the immutable selection only while table, rowid and row fingerprint still
 * match. For WITHOUT ROWID tables, the full row fingerprint is the identity.
 */
export function dbDetailMatchesPage(selection: DbDetailSelection, page: DbRowsPage): boolean {
  const current = createDbDetailSelection(page, selection.index);
  return (
    current !== null &&
    current.table === selection.table &&
    current.rowid === selection.rowid &&
    sameArray(current.columns, selection.columns) &&
    sameArray(current.row, selection.row) &&
    sameArray(current.truncated, selection.truncated)
  );
}

/* ------------------------------- result grid ------------------------------- */

function Cell({ value, align }: { value: unknown; align: 'left' | 'right' }) {
  if (value == null) return <span className="italic text-faint">NULL</span>;
  const s = typeof value === 'string' ? value : String(value);
  return (
    <span
      className={cn('block max-w-[24rem] truncate', align === 'right' && 'text-right tabular-nums')}
      title={s}
    >
      {s}
    </span>
  );
}

function ResultsTable({
  columns,
  rows,
  truncatedCells,
  colMeta,
  sort,
  onSort,
  onRowClick,
  dimmed,
}: {
  columns: string[];
  rows: unknown[][];
  truncatedCells?: boolean[][];
  colMeta?: ColMeta;
  sort?: Sort;
  onSort?: (col: string) => void;
  onRowClick?: (index: number) => void;
  dimmed?: boolean;
}) {
  // A column is right-aligned when every non-null cell is a number, or its
  // declared type is numeric (covers bigints serialized as strings).
  const numericCols = useMemo(
    () =>
      columns.map((c, ci) => {
        const t = colMeta?.[c]?.type?.toUpperCase() ?? '';
        if (/INT|REAL|NUM|DEC|DOUB|FLOA/.test(t)) return true;
        let sawValue = false;
        for (const r of rows) {
          const v = r[ci];
          if (v == null) continue;
          sawValue = true;
          if (typeof v !== 'number') return false;
        }
        return sawValue;
      }),
    [columns, rows, colMeta]
  );

  return (
    <div
      className={cn(
        'max-h-[70vh] overflow-auto rounded-xl border border-line bg-surface transition-opacity',
        dimmed && 'pointer-events-none opacity-50'
      )}
    >
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wider text-faint">
            {onRowClick && (
              <th className="sticky top-0 z-10 whitespace-nowrap border-b border-line bg-surface px-4 py-3 font-medium">
                <span className="sr-only">Row actions</span>
              </th>
            )}
            {columns.map((c, ci) => {
              const meta = colMeta?.[c];
              return (
                <th
                  key={c}
                  className={cn(
                    'sticky top-0 z-10 whitespace-nowrap border-b border-line bg-surface px-4 py-3 font-medium',
                    numericCols[ci] && 'text-right'
                  )}
                  aria-sort={
                    sort?.col === c
                      ? sort.dir === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : onSort
                        ? 'none'
                        : undefined
                  }
                >
                  {onSort ? (
                    <button
                      type="button"
                      onClick={() => onSort(c)}
                      aria-label={`Sort by ${c}`}
                      className="inline-flex items-center gap-1 uppercase tracking-wider hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                    >
                      {c}
                      {meta?.primaryKey && (
                        <span className="rounded bg-accent/15 px-1 py-0.5 text-[9px] font-semibold text-accent">
                          PK
                        </span>
                      )}
                      {meta?.type && (
                        <span className="text-faint/70">{meta.type.toLowerCase()}</span>
                      )}
                      <span
                        aria-hidden="true"
                        className={sort?.col === c ? 'text-accent' : 'text-faint/60'}
                      >
                        {sort?.col === c ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}
                      </span>
                    </button>
                  ) : (
                    c
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr
              // Rows are positional within one immutable result page.
              // biome-ignore lint/suspicious/noArrayIndexKey: rows have no stable id
              key={ri}
              className="border-b border-line font-mono text-xs last:border-0 hover:bg-surface-2/40"
            >
              {onRowClick && (
                <td className="whitespace-nowrap px-4 py-2">
                  <button
                    type="button"
                    aria-label={`View row ${ri + 1} details`}
                    onClick={() => onRowClick(ri)}
                    className="rounded-md border border-line px-2 py-1 font-sans text-[11px] font-medium text-muted transition-colors hover:border-line-strong hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    View
                  </button>
                </td>
              )}
              {r.map((v, ci) => (
                <td
                  // biome-ignore lint/suspicious/noArrayIndexKey: cells are positional
                  key={ci}
                  className="whitespace-nowrap px-4 py-2 text-muted"
                >
                  <div className="flex items-center gap-1">
                    <Cell value={v} align={numericCols[ci] ? 'right' : 'left'} />
                    {truncatedCells?.[ri]?.[ci] && (
                      <span
                        title="Value truncated — use the row's View action to read it in full"
                        className="shrink-0 rounded bg-warning/15 px-1 text-[9px] font-semibold text-warning"
                      >
                        …
                      </span>
                    )}
                  </div>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------------------------- page ---------------------------------- */

/**
 * Enterprise SQLite inspector. Browsing, schema, filtering and queries run on
 * the control agent over a `readonly` connection — writes are rejected by the
 * engine itself (and by a statement allowlist), so nothing here can mutate the
 * store. Arbitrary queries are time-boxed off-thread so a runaway scan can't
 * freeze the agent.
 */
export function Database() {
  const exportConnectionIdentity = useConnectionStore(dbConnectionIdentity);
  const [table, setTable] = useState('');
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<Sort>(null);
  const [tab, setTab] = useState<Tab>('data');
  const [filter, setFilter] = useState<DbFilter | null>(null);
  const [detailSelection, setDetailSelection] = useState<DbDetailSelection | null>(null);
  const activeModal = useGlobalModalStore((state) => state.active);
  const requestModal = useGlobalModalStore((state) => state.request);
  const releaseModal = useGlobalModalStore((state) => state.release);
  const [sql, setSql] = useState("SELECT name FROM sqlite_master WHERE type = 'table'");
  const editorRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (detailSelection === null) {
      releaseModal('database-row');
    } else if (activeModal !== 'database-row') {
      // A higher-priority modal replaced the drawer. Forget the row so closing
      // that modal cannot resurrect a stale detail panel.
      setDetailSelection(null);
    }
  }, [detailSelection, activeModal, releaseModal]);

  useEffect(
    () => () => {
      useGlobalModalStore.getState().release('database-row');
    },
    []
  );

  const {
    data: tablesRes,
    error: tablesError,
    loading: tablesLoading,
    refetch: refetchTables,
  } = usePolledData(() => bq.db.tables(), [], { intervalMs: 10000 });
  const tables = useMemo(() => tablesRes?.tables ?? [], [tablesRes]);

  // Missing file (404) is the expected pre-first-start state; any other error
  // is a real read failure and must not be shown as "no database yet".
  const dbMissing = tablesError instanceof BqError && tablesError.status === 404;

  // Store metadata — stop polling (and stop erroring) once the db is known missing.
  const {
    data: info,
    error: infoError,
    refetch: refetchInfo,
  } = usePolledData(() => (dbMissing ? Promise.resolve(null) : bq.db.info()), [dbMissing], {
    intervalMs: 15000,
  });

  // Auto-select the first table via a fallback (no first-load flash) AND commit
  // it once so the browsed view doesn't jump if the list later reorders.
  const selected = table || tables[0]?.name || '';
  useEffect(() => {
    if (!table && tables[0]) setTable(tables[0].name);
  }, [table, tables]);

  // Schema is needed for the Schema tab AND for the data-grid header badges, so
  // fetch it whenever a table is selected.
  const {
    data: schema,
    error: schemaError,
    refetch: refetchSchema,
  } = usePolledData(() => (selected ? bq.db.schema(selected) : Promise.resolve(null)), [selected], {
    intervalMs: 30000,
  });
  const colMeta: ColMeta = useMemo(() => {
    const m: ColMeta = {};
    if (schema?.table === selected) {
      for (const c of schema.columns) m[c.name] = { type: c.type, primaryKey: c.primaryKey };
    }
    return m;
  }, [schema, selected]);

  // Rows, tagged with the full view identity so a stale round-trip never renders
  // under a new table/page/sort/filter.
  const filterKey = filter ? JSON.stringify([filter.column, filter.op, filter.value]) : '';
  const fetcher = useCallback(async () => {
    if (!selected) return null;
    const expected: DbRowsIdentity = {
      table: selected,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      orderBy: sort?.col,
      dir: sort?.dir ?? 'asc',
      filter: filter ?? undefined,
    };
    const response: unknown = await bq.db.rows(
      selected,
      PAGE_SIZE,
      expected.offset,
      sort?.col,
      sort?.dir,
      filter ?? undefined
    );
    return parseDbRowsResponse(response, expected);
  }, [selected, page, sort, filter]);
  const {
    data: validatedRows,
    error: rowsError,
    loading: rowsLoading,
    refetch: refetchRows,
  } = usePolledData(fetcher, [selected, page, sort, filterKey], { intervalMs: 6000 });
  const currentRowsIdentity: DbRowsIdentity = {
    table: selected,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
    orderBy: sort?.col,
    dir: sort?.dir ?? 'asc',
    filter: filter ?? undefined,
  };
  const viewMatches = !!validatedRows && dbRowsMatchIdentity(validatedRows, currentRowsIdentity);
  const identityError =
    validatedRows && !viewMatches
      ? new Error('Database rows identity no longer matches the selected table and page.')
      : null;
  const visibleRowsError = rowsError ?? identityError;
  const data = !visibleRowsError && viewMatches ? validatedRows : null;
  const detailMatches =
    detailSelection !== null && data !== null && dbDetailMatchesPage(detailSelection, data);
  // Render fail-closed in the SAME render that publishes a changed page; the
  // cleanup effect below then releases the modal reservation.
  const detail = detailMatches ? detailSelection : null;

  useEffect(() => {
    if (detailSelection && !detailMatches) setDetailSelection(null);
  }, [detailSelection, detailMatches]);

  // Out-of-range page (rows deleted under us / stale deep link): snap to the
  // last valid page instead of showing a false "empty".
  useEffect(() => {
    if (data && data.total > 0 && data.rows.length === 0 && page > 0) {
      setPage(Math.max(0, Math.ceil(data.total / PAGE_SIZE) - 1));
    }
  }, [data, page]);

  const [exportBusy, setExportBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const exportLockRef = useRef(false);
  const exportAbortRef = useRef<AbortController | null>(null);
  // A credential/backend switch invalidates the operation immediately. The
  // collector is target-pinned as a second line of defense, but downloading A's
  // result after the operator has switched to B would still leak stale context.
  useEffect(() => {
    void exportConnectionIdentity;
    exportAbortRef.current?.abort();
    exportAbortRef.current = null;
    exportLockRef.current = false;
    setExportBusy(false);
    setMsg(null);
    return () => {
      exportAbortRef.current?.abort();
      exportAbortRef.current = null;
      exportLockRef.current = false;
    };
  }, [exportConnectionIdentity]);

  const resetView = () => {
    setPage(0);
    setSort(null);
    setFilter(null);
    setDetailSelection(null);
  };
  const selectTable = (name: string) => {
    setTable(name);
    setTab('data');
    resetView();
  };
  const cycleSort = (col: string) => {
    setPage(0);
    setDetailSelection(null);
    setSort((s) =>
      s?.col !== col ? { col, dir: 'asc' } : s.dir === 'asc' ? { col, dir: 'desc' } : null
    );
  };

  const exportPage = () => {
    if (!data) return;
    download(`${data.table}-page${page + 1}.csv`, 'text/csv', toCsv(data.columns, data.rows));
  };

  // Full-table export: one agent-side SQLite snapshot produces one bounded CSV.
  const exportTable = async () => {
    if (!selected || exportLockRef.current) return;
    exportLockRef.current = true;
    const operationIdentity = dbConnectionIdentity(useConnectionStore.getState());
    const snapshot: DbExportSnapshot = {
      table: selected,
      orderBy: sort?.col,
      dir: sort?.dir ?? 'asc',
      filter: filter ? { ...filter } : undefined,
    };
    const target = bq.captureAgentRequestTarget();
    const controller = new AbortController();
    exportAbortRef.current = controller;
    setExportBusy(true);
    setMsg(null);
    try {
      const exported = await collectTableExport(snapshot, target, controller.signal);
      if (
        controller.signal.aborted ||
        dbConnectionIdentity(useConnectionStore.getState()) !== operationIdentity
      ) {
        return;
      }
      download(`${snapshot.table}.csv`, 'text/csv;charset=utf-8', exported.content);
      const done =
        exported.cap === 'rows'
          ? `Exported the first ${formatNumber(exported.rowCount)} rows (row cap reached)`
          : exported.cap === 'bytes'
            ? `Exported ${formatNumber(exported.rowCount)} rows (${formatBytes(DB_EXPORT_MAX_BYTES)} byte cap reached)`
            : `Exported ${formatNumber(exported.rowCount)} rows`;
      setMsg(done);
      toast.success(`Export of ${snapshot.table} complete`, done);
    } catch (e) {
      if (
        controller.signal.aborted ||
        dbConnectionIdentity(useConnectionStore.getState()) !== operationIdentity
      ) {
        return;
      }
      setMsg(`Export failed: ${(e as Error).message}`);
      toast.error(`Export of ${snapshot.table} failed`, (e as Error).message);
    } finally {
      if (exportAbortRef.current === controller) {
        exportAbortRef.current = null;
        exportLockRef.current = false;
        if (!controller.signal.aborted) setExportBusy(false);
      }
    }
  };

  const queryThisTable = () => {
    const q = `SELECT * FROM "${selected.replaceAll('"', '""')}" LIMIT 100`;
    setSql(q);
    // Focus + scroll the editor into view on the next paint.
    requestAnimationFrame(() => {
      editorRef.current?.focus();
      editorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  };

  const anyTruncated = !!data?.truncatedCells.some((row) => row.some(Boolean));

  return (
    <div>
      <div
        data-database-background=""
        inert={detail ? true : undefined}
        aria-hidden={detail ? true : undefined}
      >
        <PageHeader
          title="Database"
          description="SQLite inspector — schema, data and queries over a read-only connection."
          actions={
            <span className="rounded-full bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-success">
              read-only
            </span>
          }
        />

        {tablesError && !dbMissing && (
          <OfflineBanner
            message={`Could not read the database — ${(tablesError as Error).message}`}
            onRetry={refetchTables}
          />
        )}
        {infoError && !dbMissing && (
          <OfflineBanner
            message={`Could not read database metadata — ${infoError.message}`}
            onRetry={refetchInfo}
          />
        )}

        {info && (
          <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
            <StatCard label="SQLite" value={info.sqliteVersion} compact />
            <StatCard label="On disk" value={formatBytes(info.fileSize + info.walSize)} compact />
            <StatCard label="Journal" value={info.journalMode.toUpperCase()} compact />
            <StatCard label="Tables" value={formatNumber(info.tables)} compact />
            <StatCard label="Indexes" value={formatNumber(info.indexes)} compact />
          </div>
        )}

        {dbMissing ? (
          <EmptyState title="No database yet" hint={(tablesError as Error).message} />
        ) : tablesLoading && tables.length === 0 ? (
          <LoadingState label="Reading database…" />
        ) : (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-4">
            <Card padded={false} className="self-start overflow-hidden">
              <div className="border-b border-line px-4 py-3 text-[11px] font-medium uppercase tracking-wider text-faint">
                Tables ({tables.length})
              </div>
              <ul className="max-h-[28rem] overflow-y-auto">
                {tables.map((t) => (
                  <li key={t.name}>
                    <button
                      type="button"
                      onClick={() => selectTable(t.name)}
                      className={cn(
                        'flex w-full items-center justify-between gap-2 px-4 py-2 text-left text-sm transition-colors',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
                        selected === t.name
                          ? 'bg-surface-2 text-fg'
                          : 'text-muted hover:bg-surface-2/60 hover:text-fg'
                      )}
                    >
                      <span className="min-w-0 truncate font-mono text-xs">{t.name}</span>
                      <span className="shrink-0 text-[11px] text-faint tabular-nums">
                        {formatNumber(t.rows)}
                      </span>
                    </button>
                  </li>
                ))}
                {tables.length === 0 && (
                  <li className="px-4 py-6 text-center text-xs text-faint">No tables.</li>
                )}
              </ul>
            </Card>

            <div className="min-w-0 lg:col-span-3">
              {tables.length === 0 ? (
                <EmptyState title="No tables" hint="This database has no user tables yet." />
              ) : (
                <>
                  {selected && (
                    <div className="mb-3 flex flex-wrap items-center gap-2">
                      <span
                        className="mr-auto min-w-0 truncate font-mono text-sm text-fg"
                        title={selected}
                      >
                        {selected}
                      </span>
                      <Button size="sm" variant="ghost" onClick={queryThisTable}>
                        Query
                      </Button>
                      <div className="inline-flex items-center gap-1 rounded-lg border border-line bg-surface p-1">
                        {(['data', 'schema'] as const).map((t) => (
                          <button
                            key={t}
                            type="button"
                            onClick={() => setTab(t)}
                            aria-pressed={tab === t}
                            className={cn(
                              'rounded-md px-3 py-1 text-xs font-medium capitalize transition-colors',
                              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
                              tab === t ? 'bg-surface-2 text-fg' : 'text-muted hover:text-fg'
                            )}
                          >
                            {t}
                          </button>
                        ))}
                      </div>
                      {tab === 'data' && (
                        <>
                          <Button
                            size="sm"
                            disabled={!data || data.rows.length === 0}
                            title={
                              data
                                ? `Exports the ${data.rows.length} rows on this page only`
                                : undefined
                            }
                            onClick={exportPage}
                          >
                            Export page{data ? ` (${data.rows.length})` : ''}
                          </Button>
                          <Button
                            size="sm"
                            variant="accent"
                            disabled={exportBusy || !data || data.total === 0}
                            onClick={exportTable}
                          >
                            {exportBusy
                              ? 'Exporting…'
                              : `Export table${data ? ` (${formatNumber(data.total)})` : ''}`}
                          </Button>
                        </>
                      )}
                    </div>
                  )}

                  {tab === 'data' && selected && (
                    <FilterBar
                      key={selected}
                      columns={data?.columns ?? schema?.columns.map((c) => c.name) ?? []}
                      filter={filter}
                      onChange={(f) => {
                        setFilter(f);
                        setPage(0);
                        setDetailSelection(null);
                      }}
                    />
                  )}

                  {msg && <p className="mb-3 text-xs text-muted">{msg}</p>}

                  {tab === 'schema' ? (
                    schemaError ? (
                      <EmptyState
                        title="Could not read schema"
                        hint={schemaError.message}
                        action={
                          <Button size="sm" onClick={refetchSchema}>
                            Retry
                          </Button>
                        }
                      />
                    ) : schema?.table === selected ? (
                      <SchemaView schema={schema} />
                    ) : (
                      <LoadingState label={`Reading schema of ${selected}…`} />
                    )
                  ) : visibleRowsError ? (
                    <ErrorState error={visibleRowsError} onRetry={refetchRows} />
                  ) : rowsLoading && !data ? (
                    <LoadingState label={`Reading ${selected}…`} />
                  ) : !data ? (
                    <EmptyState
                      title="Select a table"
                      hint="Pick a table on the left to browse its rows."
                    />
                  ) : data.total === 0 ? (
                    <EmptyState
                      title={filter ? 'No matching rows' : 'Empty table'}
                      hint={
                        filter
                          ? 'No rows match the current filter.'
                          : `"${data.table}" has no rows.`
                      }
                    />
                  ) : (
                    <>
                      <ResultsTable
                        columns={data.columns}
                        rows={data.rows}
                        truncatedCells={data.truncatedCells}
                        colMeta={colMeta}
                        sort={sort}
                        onSort={cycleSort}
                        onRowClick={(i) => {
                          const selection = createDbDetailSelection(data, i);
                          if (selection && requestModal('database-row')) {
                            setDetailSelection(selection);
                          }
                        }}
                        dimmed={rowsLoading && !data}
                      />
                      {anyTruncated && (
                        <p className="mt-2 text-[11px] text-faint">
                          Cells over 2000 chars and BLOBs are abbreviated in the grid and CSV — use
                          the row's View action to read the full value.
                        </p>
                      )}
                      <Pagination
                        page={page}
                        pageSize={PAGE_SIZE}
                        total={data.total}
                        onPageChange={(p) => {
                          setPage(p);
                          setDetailSelection(null);
                        }}
                        label="rows"
                      />
                    </>
                  )}

                  <QueryRunner sql={sql} setSql={setSql} editorRef={editorRef} />
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {detail &&
        activeModal === 'database-row' &&
        createPortal(
          <RowDetailDrawer
            table={detail.table}
            columns={detail.columns}
            row={detail.row}
            rowid={detail.rowid}
            truncated={detail.truncated}
            onClose={() => setDetailSelection(null)}
          />,
          document.body
        )}
    </div>
  );
}

/* -------------------------------- filter bar ------------------------------- */

function FilterBar({
  columns,
  filter,
  onChange,
}: {
  columns: string[];
  filter: DbFilter | null;
  onChange: (f: DbFilter | null) => void;
}) {
  const [col, setCol] = useState(filter?.column ?? '');
  const [op, setOp] = useState<DbFilter['op']>(filter?.op ?? 'contains');
  const [value, setValue] = useState(filter?.value ?? '');

  const effCol = col || columns[0] || '';
  const apply = () => onChange(value.trim() ? { column: effCol, op, value: value.trim() } : null);
  const clear = () => {
    setValue('');
    onChange(null);
  };

  if (columns.length === 0) return null;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <div className="w-40">
        <Select
          value={effCol}
          aria-label="Filter column"
          name="database-filter-column"
          autoComplete="off"
          onChange={(e) => setCol(e.target.value)}
        >
          {columns.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
      </div>
      <div className="w-32">
        <Select
          value={op}
          aria-label="Filter operator"
          name="database-filter-operator"
          autoComplete="off"
          onChange={(e) => setOp(e.target.value as DbFilter['op'])}
        >
          <option value="contains">contains</option>
          <option value="eq">=</option>
          <option value="ne">≠</option>
        </Select>
      </div>
      <div className="relative min-w-40 flex-1">
        <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && apply()}
          aria-label="Filter value"
          name="database-filter-value"
          autoComplete="off"
          placeholder="value — Enter to filter"
          className="h-9 w-full rounded-lg border border-line bg-surface pl-8 pr-3 text-sm text-fg placeholder:text-faint focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/30"
        />
      </div>
      <Button size="sm" onClick={apply} disabled={!value.trim()}>
        Filter
      </Button>
      {filter && (
        <Button size="sm" variant="ghost" onClick={clear}>
          Clear
        </Button>
      )}
      <span className="text-[11px] text-faint">filters the whole table, server-side</span>
    </div>
  );
}

/* ------------------------------- row detail -------------------------------- */

const DIALOG_FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function RowDetailDrawer({
  table,
  columns,
  row,
  rowid,
  truncated,
  onClose,
}: {
  table: string;
  columns: string[];
  row: unknown[];
  rowid: number | string | null;
  truncated: boolean[];
  onClose: () => void;
}) {
  // Full values for cells the grid truncated, lazy-fetched by rowid.
  const [full, setFull] = useState<Record<string, unknown>>({});
  const [loadErrors, setLoadErrors] = useState<Record<string, string>>({});
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const invoker = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const focusables = () =>
      panel
        ? Array.from(panel.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE)).filter(
            (element) => element.getAttribute('aria-hidden') !== 'true'
          )
        : [];
    const focusInside = (last = false) => {
      const candidates = focusables();
      (last ? candidates.at(-1) : candidates[0])?.focus();
      if (candidates.length === 0) panel?.focus();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const candidates = focusables();
      if (candidates.length === 0) {
        event.preventDefault();
        panel?.focus();
        return;
      }
      const active = document.activeElement as HTMLElement | null;
      const first = candidates[0];
      const last = candidates[candidates.length - 1];
      if (event.shiftKey && (active === first || !active || !panel?.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !active || !panel?.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    const onFocus = (event: FocusEvent) => {
      if (panel && !panel.contains(event.target as Node)) focusInside();
    };

    closeRef.current?.focus();
    if (document.activeElement !== closeRef.current) panel?.focus();
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', onFocus);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('focusin', onFocus);
      if (mayRestoreModalFocus('database-row') && invoker?.isConnected) invoker.focus();
    };
  }, []);

  // Stable key of the truncated columns in this immutable row selection.
  const truncatedKey = JSON.stringify(columns.filter((_, i) => truncated[i]));
  useEffect(() => {
    // Drop the previous selection's fetched cells before issuing its own reads.
    setFull({});
    setLoadErrors({});
    const cols = JSON.parse(truncatedKey) as string[];
    if (rowid == null || cols.length === 0) return;
    let cancelled = false;
    void Promise.all(
      cols.map(async (col) => {
        try {
          const r = await bq.db.cell(table, rowid, col);
          if (!r || typeof r !== 'object' || !Object.hasOwn(r, 'value')) {
            throw new Error('Malformed full-cell response.');
          }
          if (!cancelled) setFull((current) => ({ ...current, [col]: r.value }));
        } catch (error) {
          if (!cancelled) {
            const message = error instanceof Error ? error.message : String(error);
            setLoadErrors((current) => ({ ...current, [col]: message.slice(0, 300) }));
          }
        }
      })
    );
    return () => {
      cancelled = true;
    };
  }, [table, rowid, truncatedKey]);

  return (
    <>
      <button
        type="button"
        aria-label="Close row detail"
        onClick={onClose}
        className="fixed inset-0 z-40 bg-black/50"
      />
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`${table} row ${rowid ?? 'detail'}`}
        tabIndex={-1}
        className="fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col border-l border-line bg-surface shadow-xl focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="font-mono text-sm text-fg">{table} · row detail</h2>
          <button
            ref={closeRef}
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="flex size-8 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
          >
            <IconClose className="size-4" />
          </button>
        </div>
        <div className="flex-1 overscroll-contain overflow-y-auto p-5">
          <dl className="flex flex-col gap-4">
            {columns.map((c, i) => {
              const loaded = Object.hasOwn(full, c);
              const value = loaded ? full[c] : row[i];
              const text = pretty(value);
              const multiline = text.includes('\n') || text.length > 80;
              return (
                <div key={c}>
                  <dt className="mb-1 flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-faint">
                    {c}
                    {value != null && <CopyButton value={String(value)} />}
                    {truncated[i] &&
                      !loaded &&
                      (Object.hasOwn(loadErrors, c) ? (
                        <span role="alert" className="normal-case text-danger">
                          (full value unavailable — {loadErrors[c]})
                        </span>
                      ) : (
                        <span className="text-warning">(loading full value…)</span>
                      ))}
                  </dt>
                  <dd>
                    {value == null ? (
                      <span className="italic text-faint">NULL</span>
                    ) : multiline ? (
                      <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-2 p-3 font-mono text-xs text-muted">
                        {text}
                      </pre>
                    ) : (
                      <span className="break-words font-mono text-sm text-fg">{text}</span>
                    )}
                  </dd>
                </div>
              );
            })}
          </dl>
        </div>
      </aside>
    </>
  );
}

/* --------------------------------- schema --------------------------------- */

function SchemaView({
  schema,
}: {
  schema: {
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
  };
}) {
  return (
    <div className="flex flex-col gap-6">
      <div className="overflow-x-auto rounded-xl border border-line bg-surface">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-faint">
              <th className="px-4 py-3 font-medium">Column</th>
              <th className="px-4 py-3 font-medium">Type</th>
              <th className="px-4 py-3 font-medium">Constraints</th>
              <th className="px-4 py-3 font-medium">Default</th>
            </tr>
          </thead>
          <tbody>
            {schema.columns.map((c) => (
              <tr key={c.name} className="border-b border-line last:border-0">
                <td className="px-4 py-2 font-mono text-xs text-fg">{c.name}</td>
                <td className="px-4 py-2 font-mono text-xs text-muted">{c.type}</td>
                <td className="px-4 py-2 text-xs">
                  {c.primaryKey && (
                    <span className="mr-1 rounded-md bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold text-accent">
                      PK
                    </span>
                  )}
                  {c.notNull && (
                    <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold text-muted">
                      NOT NULL
                    </span>
                  )}
                </td>
                <td className="px-4 py-2 font-mono text-xs text-faint">{c.defaultValue ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Card>
        <CardHeader title={`Indexes (${schema.indexes.length})`} />
        {schema.indexes.length === 0 ? (
          <p className="text-xs text-faint">No indexes on this table.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {schema.indexes.map((ix) => (
              <li key={ix.name} className="flex flex-wrap items-center gap-2 font-mono text-xs">
                <span className="text-fg">{ix.name}</span>
                {ix.unique && (
                  <span className="rounded-md bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold text-accent">
                    UNIQUE
                  </span>
                )}
                <span className="text-faint">({ix.columns.join(', ')})</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {schema.sql && (
        <Card>
          <CardHeader title="DDL" action={<CopyButton value={schema.sql} />} />
          <pre className="overflow-x-auto rounded-lg bg-surface-2 p-3 font-mono text-xs text-muted">
            {schema.sql}
          </pre>
        </Card>
      )}
    </div>
  );
}

/* ------------------------------- query runner ------------------------------ */

const dbConnectionIdentity = (state: { baseUrl: string; token: string; agentToken: string }) =>
  JSON.stringify([state.baseUrl, state.token, state.agentToken]);

interface DbQueryView {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  ms: number;
}

export function parseDbQueryResponse(value: unknown): DbQueryView {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Malformed database query response.');
  }
  const result = value as Record<string, unknown>;
  if (
    result.ok !== true ||
    !Array.isArray(result.columns) ||
    result.columns.some((column) => typeof column !== 'string') ||
    !Array.isArray(result.rows) ||
    result.rows.length > 500 ||
    result.rows.some(
      (row) => !Array.isArray(row) || row.length !== (result.columns as unknown[]).length
    ) ||
    !Number.isSafeInteger(result.rowCount) ||
    result.rowCount !== result.rows.length ||
    typeof result.truncated !== 'boolean' ||
    typeof result.ms !== 'number' ||
    !Number.isFinite(result.ms) ||
    result.ms < 0
  ) {
    throw new Error('Malformed database query response.');
  }
  return {
    columns: [...(result.columns as string[])],
    rows: (result.rows as unknown[][]).map((row) => [...row]),
    rowCount: result.rowCount as number,
    truncated: result.truncated,
    ms: result.ms,
  };
}

export function QueryRunner({
  sql,
  setSql,
  editorRef,
}: {
  sql: string;
  setSql: (s: string) => void;
  editorRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const connectionIdentity = useConnectionStore(dbConnectionIdentity);
  const [runningTarget, setRunningTarget] = useState<string | null>(null);
  const [error, setError] = useState<{ target: string; message: string } | null>(null);
  const [history, setHistory] = useState<string[]>(loadHistory);
  const [result, setResult] = useState<{
    target: string;
    columns: string[];
    rows: unknown[][];
    rowCount: number;
    truncated: boolean;
    ms: number;
  } | null>(null);
  // Last-to-start wins; also invalidate any in-flight query on unmount.
  const gen = useRef(0);
  const activeQuery = useRef<{ generation: number; target: string } | null>(null);
  const renderedTarget = useRef(connectionIdentity);
  if (renderedTarget.current !== connectionIdentity) {
    // Render-time invalidation hides server A's result in the very render that
    // switches to B; the effect below then clears the backing state.
    renderedTarget.current = connectionIdentity;
    gen.current++;
    activeQuery.current = null;
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: the connection identity is the invalidation trigger
  useEffect(() => {
    gen.current++;
    activeQuery.current = null;
    setRunningTarget(null);
    setError(null);
    setResult(null);
    return () => {
      gen.current++;
      activeQuery.current = null;
    };
  }, [connectionIdentity]);

  const running = runningTarget === connectionIdentity;
  const visibleError = error?.target === connectionIdentity ? error.message : null;
  const visibleResult = result?.target === connectionIdentity ? result : null;

  const run = async (text = sql, persist = true) => {
    const query = text.trim();
    if (!query || activeQuery.current?.target === connectionIdentity) return;
    const my = ++gen.current;
    const target = connectionIdentity;
    activeQuery.current = { generation: my, target };
    setRunningTarget(target);
    setError(null);
    try {
      const r = parseDbQueryResponse(await bq.db.query(text));
      if (my !== gen.current || dbConnectionIdentity(useConnectionStore.getState()) !== target) {
        return;
      }
      setResult({ ...r, target });
      if (persist) setHistory(pushHistory(query));
    } catch (e) {
      if (my !== gen.current || dbConnectionIdentity(useConnectionStore.getState()) !== target) {
        return;
      }
      setResult(null);
      setError({ target, message: (e as Error).message });
    } finally {
      if (activeQuery.current?.generation === my) activeQuery.current = null;
      if (my === gen.current) setRunningTarget(null);
    }
  };
  // Explain runs the plan but must not pollute history with the prefixed string.
  const explain = () => {
    const text = sql.trim();
    if (text) run(`EXPLAIN QUERY PLAN ${text}`, false);
  };
  const clearHistory = () => {
    writeHistory([]);
    setHistory([]);
  };

  return (
    <Card className="mt-6">
      <CardHeader
        title="Query"
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={running || !sql.trim()} onClick={explain}>
              Explain
            </Button>
            <Button
              size="sm"
              variant="accent"
              disabled={running || !sql.trim()}
              onClick={() => run()}
            >
              {running ? 'Running…' : 'Run'}
            </Button>
          </div>
        }
      />
      <textarea
        name="database-sql-query"
        autoComplete="off"
        ref={editorRef}
        value={sql}
        onChange={(e) => setSql(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) run();
        }}
        rows={3}
        spellCheck={false}
        aria-label="SQL query"
        placeholder="SELECT … — read-only: writes are rejected by the engine"
        className="w-full resize-y rounded-lg border border-line bg-surface-2 p-3 font-mono text-xs text-fg placeholder:text-faint focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/30"
      />
      <p className="mt-1 text-[11px] text-faint">⌘/Ctrl+Enter runs. Connection is read-only.</p>

      {history.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] uppercase tracking-wider text-faint">History</span>
          {history.map((h) => (
            <button
              key={h}
              type="button"
              onClick={() => setSql(h)}
              title={h}
              className="max-w-56 truncate rounded-md border border-line bg-surface-2 px-2 py-1 font-mono text-[11px] text-muted transition-colors hover:border-line-strong hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
            >
              {h}
            </button>
          ))}
          <button
            type="button"
            onClick={clearHistory}
            className="rounded-md px-2 py-1 text-[11px] text-faint transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
          >
            Clear
          </button>
        </div>
      )}

      {/* Always-mounted live region so the first result/error is announced. */}
      <div aria-live="polite">
        {visibleError && (
          <p role="alert" className="mt-3 text-xs text-danger">
            {visibleError}
          </p>
        )}
        {visibleResult && !visibleError && (
          <div className="mt-4">
            <div className="mb-2 flex flex-wrap items-center gap-3">
              <p className="text-xs text-faint">
                {visibleResult.truncated ? '≥ ' : ''}
                {formatNumber(visibleResult.rowCount)} row
                {visibleResult.rowCount === 1 ? '' : 's'} · {formatNumber(visibleResult.ms)} ms
                {visibleResult.truncated && (
                  <span className="text-warning"> — showing first {visibleResult.rows.length}</span>
                )}
              </p>
              {visibleResult.rows.length > 0 && (
                <div className="ml-auto flex gap-2">
                  <Button
                    size="sm"
                    onClick={() =>
                      download(
                        'query-results.csv',
                        'text/csv',
                        toCsv(visibleResult.columns, visibleResult.rows)
                      )
                    }
                  >
                    CSV
                  </Button>
                  <Button
                    size="sm"
                    onClick={() =>
                      download(
                        'query-results.json',
                        'application/json',
                        JSON.stringify(
                          visibleResult.rows.map((r) =>
                            Object.fromEntries(visibleResult.columns.map((c, i) => [c, r[i]]))
                          ),
                          null,
                          2
                        )
                      )
                    }
                  >
                    JSON
                  </Button>
                </div>
              )}
            </div>
            {visibleResult.rows.length > 0 ? (
              <ResultsTable columns={visibleResult.columns} rows={visibleResult.rows} />
            ) : (
              <p className="text-xs text-faint">Query returned no rows.</p>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
