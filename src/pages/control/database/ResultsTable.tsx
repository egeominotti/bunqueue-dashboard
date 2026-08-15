import { useMemo } from 'react';
import { cn } from '@/lib/cn';
import type { ColMeta, Sort } from './types';

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

export function ResultsTable({
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
              // oxlint-disable-next-line react/no-array-index-key -- rows have no stable id
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
                  // oxlint-disable-next-line react/no-array-index-key -- cells are positional
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
