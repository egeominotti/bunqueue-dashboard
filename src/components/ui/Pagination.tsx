import { formatNumber } from '@/lib/format';

/**
 * Shared pagination control. Two modes:
 *  - **known total** (`total` provided): shows "X–Y of Z" and computes the last
 *    page, so Next disables on the final page. Use for server endpoints that
 *    return a total (`/dashboard/queues`, `/queues/:q/dlq`) or client-side
 *    paginated full lists (crons, webhooks, workers, activity buffer).
 *  - **unknown total** (`hasNext` provided instead): shows "Page N" and drives
 *    Next off `hasNext`. Use for `/queues/:q/jobs/list`, which paginates by
 *    offset/limit but returns no total (hasNext = received === pageSize).
 *
 * `page` is 0-based. Renders nothing when there's a single page of known data.
 */
export function Pagination({
  page,
  pageSize,
  total,
  hasNext,
  onPageChange,
  label = 'items',
  className,
}: {
  page: number;
  pageSize: number;
  total?: number;
  hasNext?: boolean;
  onPageChange: (page: number) => void;
  label?: string;
  className?: string;
}) {
  const knownTotal = total != null;
  const pageCount = knownTotal ? Math.max(1, Math.ceil(total / pageSize)) : undefined;
  const start = page * pageSize;
  const canPrev = page > 0;
  const canNext = knownTotal ? page < (pageCount as number) - 1 : !!hasNext;

  // Nothing to page through and nowhere to go: don't render a dead control.
  if (knownTotal && (total as number) <= pageSize && page === 0) return null;

  const summary = knownTotal
    ? (total as number) === 0
      ? `No ${label}`
      : `${formatNumber(start + 1)}–${formatNumber(Math.min(start + pageSize, total as number))} of ${formatNumber(total as number)} ${label}`
    : `Page ${page + 1}`;

  return (
    <div className={`mt-4 flex items-center justify-between text-sm text-faint ${className ?? ''}`}>
      <span>{summary}</span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={!canPrev}
          onClick={() => onPageChange(page - 1)}
          className="rounded-md px-3 py-1 text-xs hover:text-fg disabled:opacity-40 disabled:hover:text-faint"
        >
          Previous
        </button>
        <span className="rounded-md bg-accent/15 px-2.5 py-1 text-xs font-medium text-accent tnum">
          {knownTotal ? `${page + 1} / ${pageCount}` : page + 1}
        </span>
        <button
          type="button"
          disabled={!canNext}
          onClick={() => onPageChange(page + 1)}
          className="rounded-md px-3 py-1 text-xs hover:text-fg disabled:opacity-40 disabled:hover:text-faint"
        >
          Next
        </button>
      </div>
    </div>
  );
}
