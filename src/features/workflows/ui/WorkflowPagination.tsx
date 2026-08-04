export function WorkflowPagination({
  total,
  offset,
  pageSize,
  count,
  onPage,
}: {
  total: number;
  offset: number;
  pageSize: number;
  count: number;
  onPage: (offset: number) => void;
}) {
  const first = count === 0 ? 0 : offset + 1;
  const last = Math.min(offset + count, total);
  return (
    <nav aria-label="Workflow execution pages" className="mt-3 flex items-center justify-between">
      <button
        type="button"
        disabled={offset === 0}
        onClick={() => onPage(Math.max(0, offset - pageSize))}
        className="rounded-lg border border-line px-3 py-1.5 text-xs text-muted disabled:opacity-40"
      >
        Previous
      </button>
      <span className="text-xs text-faint">
        {first}–{last} of {total}
      </span>
      <button
        type="button"
        disabled={offset + pageSize >= total}
        onClick={() => onPage(offset + pageSize)}
        className="rounded-lg border border-line px-3 py-1.5 text-xs text-muted disabled:opacity-40"
      >
        Next
      </button>
    </nav>
  );
}
