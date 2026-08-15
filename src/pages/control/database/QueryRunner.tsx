import { useEffect, useRef, useState } from 'react';
import { useConnectionStore } from '@/components/dashboard/stores/connectionStore';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { bq } from '@/lib/bq';
import { formatNumber } from '@/lib/format';
import {
  dbConnectionIdentity,
  download,
  loadHistory,
  pushHistory,
  toCsv,
  writeHistory,
} from './dbUtils';
import { ResultsTable } from './ResultsTable';

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
  // The connection identity is the invalidation trigger.
  useEffect(() => {
    gen.current++;
    activeQuery.current = null;
    setRunningTarget(null);
    setError(null);
    setResult(null);
    return () => {
      // oxlint-disable-next-line react/exhaustive-deps -- the shared generation ref invalidates this request on cleanup
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
