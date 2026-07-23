import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from '@/components/dashboard/stores/toastStore';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { CopyButton } from '@/components/ui/CopyButton';
import { EmptyState, LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { Select } from '@/components/ui/form';
import { IconClose, IconSearch } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { StatCard } from '@/components/ui/StatCard';
import { BqError, bq, type DbFilter } from '@/lib/bq';
import { cn } from '@/lib/cn';
import { formatBytes, formatNumber } from '@/lib/format';
import { usePolledData } from '@/lib/usePolledData';

const PAGE_SIZE = 50;
const EXPORT_BATCH = 500; // matches agent MAX_ROWS
const EXPORT_MAX_ROWS = 200_000; // hard cap so a growing table can't accumulate unbounded in the tab
const HISTORY_KEY = 'bq-dash-db-history';
const HISTORY_MAX = 10;

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
export function download(name: string, mime: string, content: string) {
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
function loadHistory(): string[] {
  try {
    const h = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]');
    return Array.isArray(h) ? h.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
function writeHistory(next: string[]): string[] {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch {
    /* storage full/unavailable — history is a convenience only */
  }
  return next;
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
              onClick={onRowClick ? () => onRowClick(ri) : undefined}
              onKeyDown={
                onRowClick
                  ? (e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onRowClick(ri);
                      }
                    }
                  : undefined
              }
              tabIndex={onRowClick ? 0 : undefined}
              className={cn(
                'border-b border-line font-mono text-xs last:border-0 hover:bg-surface-2/40',
                onRowClick && 'cursor-pointer'
              )}
            >
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
                        title="Value truncated — click the row to view it in full"
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
  const [table, setTable] = useState('');
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<Sort>(null);
  const [tab, setTab] = useState<Tab>('data');
  const [filter, setFilter] = useState<DbFilter | null>(null);
  const [detailRow, setDetailRow] = useState<number | null>(null);
  const [sql, setSql] = useState("SELECT name FROM sqlite_master WHERE type = 'table'");
  const editorRef = useRef<HTMLTextAreaElement>(null);

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
  const { data: info } = usePolledData(
    () => (dbMissing ? Promise.resolve(null) : bq.db.info()),
    [dbMissing],
    { intervalMs: 15000 }
  );

  // Auto-select the first table via a fallback (no first-load flash) AND commit
  // it once so the browsed view doesn't jump if the list later reorders.
  const selected = table || tables[0]?.name || '';
  useEffect(() => {
    if (!table && tables[0]) setTable(tables[0].name);
  }, [table, tables]);

  // Schema is needed for the Schema tab AND for the data-grid header badges, so
  // fetch it whenever a table is selected.
  const { data: schema } = usePolledData(
    () => (selected ? bq.db.schema(selected) : Promise.resolve(null)),
    [selected],
    { intervalMs: 30000 }
  );
  const colMeta: ColMeta = useMemo(() => {
    const m: ColMeta = {};
    if (schema?.table === selected) {
      for (const c of schema.columns) m[c.name] = { type: c.type, primaryKey: c.primaryKey };
    }
    return m;
  }, [schema, selected]);

  // Rows, tagged with the full view identity so a stale round-trip never renders
  // under a new table/page/sort/filter.
  const filterKey = filter ? `${filter.column}|${filter.op}|${filter.value}` : '';
  const fetcher = useCallback(async () => {
    if (!selected) return null;
    const r = await bq.db.rows(
      selected,
      PAGE_SIZE,
      page * PAGE_SIZE,
      sort?.col,
      sort?.dir,
      filter ?? undefined
    );
    return { ...r, page, filterKey };
  }, [selected, page, sort, filter, filterKey]);
  const {
    data: raw,
    error: rowsError,
    loading: rowsLoading,
  } = usePolledData(fetcher, [selected, page, sort, filterKey], { intervalMs: 6000 });
  const viewMatches =
    !!raw &&
    raw.table === selected &&
    raw.page === page &&
    raw.orderBy === (sort?.col ?? null) &&
    (sort ? raw.dir === sort.dir : true) &&
    raw.filterKey === filterKey;
  const data = viewMatches ? raw : null;

  // Out-of-range page (rows deleted under us / stale deep link): snap to the
  // last valid page instead of showing a false "empty".
  useEffect(() => {
    if (data && data.total > 0 && data.rows.length === 0 && page > 0) {
      setPage(Math.max(0, Math.ceil(data.total / PAGE_SIZE) - 1));
    }
  }, [data, page]);

  const [exportBusy, setExportBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const resetView = () => {
    setPage(0);
    setSort(null);
    setFilter(null);
    setDetailRow(null);
  };
  const selectTable = (name: string) => {
    setTable(name);
    setTab('data');
    resetView();
  };
  const cycleSort = (col: string) => {
    setPage(0);
    setDetailRow(null);
    setSort((s) =>
      s?.col !== col ? { col, dir: 'asc' } : s.dir === 'asc' ? { col, dir: 'desc' } : null
    );
  };

  const exportPage = () => {
    if (!data) return;
    download(`${data.table}-page${page + 1}.csv`, 'text/csv', toCsv(data.columns, data.rows));
  };

  // Full-table export: page through the whole (optionally filtered/sorted) set
  // in agent-capped batches, then download one CSV.
  const exportTable = async () => {
    if (!selected || exportBusy) return;
    setExportBusy(true);
    setMsg(null);
    try {
      const all: unknown[][] = [];
      let cols: string[] = [];
      let off = 0;
      let capped = false;
      // Bound by total from the current view; the hard cap guards against a
      // table that grows faster than we can drain it (unbounded tab memory).
      for (;;) {
        const r = await bq.db.rows(
          selected,
          EXPORT_BATCH,
          off,
          sort?.col,
          sort?.dir,
          filter ?? undefined
        );
        cols = r.columns;
        all.push(...r.rows);
        off += EXPORT_BATCH;
        // Natural end first: a table of exactly EXPORT_MAX_ROWS rows is fully
        // exported, not "capped" — the cap only fires when rows remain unread.
        if (r.rows.length < EXPORT_BATCH || off >= r.total) break;
        if (all.length >= EXPORT_MAX_ROWS) {
          capped = true;
          break;
        }
      }
      download(`${selected}.csv`, 'text/csv', toCsv(cols, all));
      const done = capped
        ? `Exported the first ${formatNumber(all.length)} rows (export cap reached)`
        : `Exported ${formatNumber(all.length)} rows`;
      setMsg(done);
      toast.success(`Export of ${selected} complete`, done);
    } catch (e) {
      setMsg(`Export failed: ${(e as Error).message}`);
      toast.error(`Export of ${selected} failed`, (e as Error).message);
    } finally {
      setExportBusy(false);
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
                      setDetailRow(null);
                    }}
                  />
                )}

                {msg && <p className="mb-3 text-xs text-muted">{msg}</p>}

                {tab === 'schema' ? (
                  schema?.table === selected ? (
                    <SchemaView schema={schema} />
                  ) : (
                    <LoadingState label={`Reading schema of ${selected}…`} />
                  )
                ) : rowsError && !data ? (
                  <EmptyState title="Could not read table" hint={(rowsError as Error).message} />
                ) : rowsLoading && !data && raw?.table !== selected ? (
                  <LoadingState label={`Reading ${selected}…`} />
                ) : !data && !raw ? (
                  <EmptyState
                    title="Select a table"
                    hint="Pick a table on the left to browse its rows."
                  />
                ) : (data ?? raw) && (data ?? raw)?.total === 0 ? (
                  <EmptyState
                    title={filter ? 'No matching rows' : 'Empty table'}
                    hint={
                      filter
                        ? 'No rows match the current filter.'
                        : `"${(data ?? raw)?.table}" has no rows.`
                    }
                  />
                ) : (
                  <>
                    <ResultsTable
                      columns={(data ?? raw)?.columns ?? []}
                      rows={(data ?? raw)?.rows ?? []}
                      truncatedCells={(data ?? raw)?.truncatedCells}
                      colMeta={colMeta}
                      sort={sort}
                      onSort={cycleSort}
                      onRowClick={(i) => setDetailRow(i)}
                      dimmed={rowsLoading && !data}
                    />
                    {anyTruncated && (
                      <p className="mt-2 text-[11px] text-faint">
                        Cells over 2000 chars and BLOBs are abbreviated in the grid and CSV — click
                        a row to view the full value.
                      </p>
                    )}
                    <Pagination
                      page={page}
                      pageSize={PAGE_SIZE}
                      total={(data ?? raw)?.total ?? 0}
                      onPageChange={(p) => {
                        setPage(p);
                        setDetailRow(null);
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

      {data && detailRow != null && data.rows[detailRow] && (
        <RowDetailDrawer
          table={data.table}
          columns={data.columns}
          row={data.rows[detailRow]}
          rowid={data.rowids[detailRow]}
          truncated={data.truncatedCells[detailRow]}
          onClose={() => setDetailRow(null)}
        />
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
        <Select value={effCol} aria-label="Filter column" onChange={(e) => setCol(e.target.value)}>
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

function RowDetailDrawer({
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
  rowid: number | null;
  truncated: boolean[];
  onClose: () => void;
}) {
  // Full values for cells the grid truncated, lazy-fetched by rowid.
  const [full, setFull] = useState<Record<string, unknown>>({});
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Dialog focus contract: move focus into the drawer on open, hand it back to
  // the invoking row (or whatever was focused) on close.
  useEffect(() => {
    const invoker = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => {
      if (invoker?.isConnected) invoker.focus();
    };
  }, []);

  // Stable key of the truncated columns for this row. `columns`/`truncated` are
  // fresh array refs on every 6s poll, so depending on them re-fetched every
  // cell each tick; the truncated set for a fixed row doesn't change between polls.
  const truncatedKey = columns.filter((_, i) => truncated[i]).join('\u0001');
  useEffect(() => {
    // Drop the previous row's fetched cells first: the 6s poll can swap a
    // different row under the same drawer index, and a stale `full` entry would
    // render another row's value under this row's column header.
    setFull({});
    if (rowid == null || !truncatedKey) return;
    const cols = truncatedKey.split('\u0001');
    let cancelled = false;
    (async () => {
      for (const col of cols) {
        try {
          const r = await bq.db.cell(table, rowid, col);
          if (!cancelled) setFull((f) => ({ ...f, [col]: r.value }));
        } catch {
          /* leave the truncated grid value in place */
        }
      }
    })();
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
        className="fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col border-l border-line bg-surface shadow-xl focus-visible:outline-none"
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="font-mono text-sm text-fg">{table} · row detail</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="flex size-8 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
          >
            <IconClose className="size-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          <dl className="flex flex-col gap-4">
            {columns.map((c, i) => {
              const value = c in full ? full[c] : row[i];
              const text = pretty(value);
              const multiline = text.includes('\n') || text.length > 80;
              return (
                <div key={c}>
                  <dt className="mb-1 flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-faint">
                    {c}
                    {value != null && <CopyButton value={String(value)} />}
                    {truncated[i] && !(c in full) && (
                      <span className="text-warning">(loading full value…)</span>
                    )}
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
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-base font-semibold text-fg">DDL</h3>
            <CopyButton value={schema.sql} />
          </div>
          <pre className="overflow-x-auto rounded-lg bg-surface-2 p-3 font-mono text-xs text-muted">
            {schema.sql}
          </pre>
        </Card>
      )}
    </div>
  );
}

/* ------------------------------- query runner ------------------------------ */

function QueryRunner({
  sql,
  setSql,
  editorRef,
}: {
  sql: string;
  setSql: (s: string) => void;
  editorRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>(loadHistory);
  const [result, setResult] = useState<{
    columns: string[];
    rows: unknown[][];
    rowCount: number;
    truncated: boolean;
    ms: number;
  } | null>(null);
  // Last-to-start wins; also invalidate any in-flight query on unmount.
  const gen = useRef(0);
  useEffect(
    () => () => {
      gen.current++;
    },
    []
  );

  const run = async (text = sql, persist = true) => {
    if (!text.trim() || running) return;
    const my = ++gen.current;
    setRunning(true);
    setError(null);
    try {
      const r = await bq.db.query(text);
      if (my !== gen.current) return;
      setResult(r);
      if (persist) setHistory(pushHistory(sql.trim()));
    } catch (e) {
      if (my !== gen.current) return;
      setResult(null);
      setError((e as Error).message);
    } finally {
      if (my === gen.current) setRunning(false);
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
        {error && (
          <p role="alert" className="mt-3 text-xs text-danger">
            {error}
          </p>
        )}
        {result && !error && (
          <div className="mt-4">
            <div className="mb-2 flex flex-wrap items-center gap-3">
              <p className="text-xs text-faint">
                {result.truncated ? '≥ ' : ''}
                {formatNumber(result.rowCount)} row{result.rowCount === 1 ? '' : 's'} ·{' '}
                {formatNumber(result.ms)} ms
                {result.truncated && (
                  <span className="text-warning"> — showing first {result.rows.length}</span>
                )}
              </p>
              {result.rows.length > 0 && (
                <div className="ml-auto flex gap-2">
                  <Button
                    size="sm"
                    onClick={() =>
                      download('query-results.csv', 'text/csv', toCsv(result.columns, result.rows))
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
                          result.rows.map((r) =>
                            Object.fromEntries(result.columns.map((c, i) => [c, r[i]]))
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
            {result.rows.length > 0 ? (
              <ResultsTable columns={result.columns} rows={result.rows} />
            ) : (
              <p className="text-xs text-faint">Query returned no rows.</p>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
