import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState, ErrorState, LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { StatCard } from '@/components/ui/StatCard';
import { cn } from '@/lib/cn';
import { formatBytes, formatNumber } from '@/lib/format';
import { FilterBar } from './FilterBar';
import { QueryRunner } from './QueryRunner';
import { ResultsTable } from './ResultsTable';
import { createDbDetailSelection } from './rowModel';
import { SchemaView } from './SchemaView';
import type { DatabaseController } from './useDatabaseController';

export function DatabaseShell({ db }: { db: DatabaseController }) {
  const {
    anyTruncated,
    colMeta,
    cycleSort,
    data,
    dbMissing,
    detail,
    editorRef,
    exportBusy,
    exportPage,
    exportTable,
    filter,
    info,
    infoError,
    msg,
    page,
    pageSize,
    queryThisTable,
    refetchInfo,
    refetchRows,
    refetchSchema,
    refetchTables,
    requestModal,
    rowsLoading,
    schema,
    schemaError,
    selectTable,
    selected,
    setDetailSelection,
    setFilter,
    setPage,
    setSql,
    setTab,
    sort,
    sql,
    tab,
    tables,
    tablesError,
    tablesLoading,
    visibleRowsError,
  } = db;

  return (
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
                      filter ? 'No rows match the current filter.' : `"${data.table}" has no rows.`
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
                      pageSize={pageSize}
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
  );
}
