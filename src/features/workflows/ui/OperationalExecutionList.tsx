import { StatusBadge } from '@/components/ui/StatusBadge';
import type { WorkflowExecutionSummary } from '@/lib/bqTypes';
import { cn } from '@/lib/cn';
import { formatDateTime, formatDuration, formatRelativeTime } from '@/lib/format';
import type { WorkflowSelection } from '../domain/workflowSections';
import { systemWorkflowClock, useWorkflowNow, type WorkflowClock } from './WorkflowDetailState';
import { WorkflowPagination } from './WorkflowPagination';

export type OperationalListMode = 'waiting' | 'compensation' | 'archive';

export function OperationalExecutionList({
  mode,
  rows,
  selected,
  onSelect,
  total,
  offset,
  pageSize,
  onPage,
  clock = systemWorkflowClock,
}: {
  mode: OperationalListMode;
  rows: WorkflowExecutionSummary[];
  selected: WorkflowSelection | null;
  onSelect: (value: WorkflowSelection) => void;
  total: number;
  offset: number;
  pageSize: number;
  onPage: (offset: number) => void;
  clock?: WorkflowClock;
}) {
  const now = useWorkflowNow(clock, mode === 'waiting');
  return (
    <div>
      <section className="overflow-x-auto rounded-lg border border-line bg-surface">
        <table className="w-full min-w-[560px] text-sm">
          <thead className="border-b border-line bg-surface-2/80 text-left text-[10px] uppercase tracking-wider text-faint">
            <tr>
              <th className="px-3 py-2 font-medium">
                {mode === 'archive' ? 'Execution record' : 'Execution'}
              </th>
              <th className="px-3 py-2 font-medium">Workflow</th>
              <th className="px-3 py-2 font-medium">{middleHeading(mode)}</th>
              <th className="px-3 py-2 text-right font-medium">{lastHeading(mode)}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.id}
                className={cn(
                  'border-b border-line last:border-0',
                  selected?.id === row.id && 'bg-surface-2'
                )}
              >
                <td className="p-0">
                  <button
                    type="button"
                    className="block w-full px-3 py-3 text-left font-mono text-xs text-fg"
                    onClick={() => onSelect({ id: row.id, source: 'page' })}
                  >
                    {row.id}
                  </button>
                </td>
                <td className="px-3 py-3 text-muted">{row.workflowName}</td>
                <td className="px-3 py-3">
                  <MiddleValue mode={mode} row={row} />
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-right text-xs text-muted">
                  {lastValue(mode, row, now)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <WorkflowPagination
        total={total}
        offset={offset}
        pageSize={pageSize}
        count={rows.length}
        onPage={onPage}
      />
    </div>
  );
}

const middleHeading = (mode: OperationalListMode) => {
  if (mode === 'waiting') return 'Resume node';
  if (mode === 'compensation') return 'Recovery state';
  return 'Outcome';
};

const lastHeading = (mode: OperationalListMode) =>
  mode === 'archive' ? 'Archived' : mode === 'waiting' ? 'Waiting' : 'Updated';

function MiddleValue({ mode, row }: { mode: OperationalListMode; row: WorkflowExecutionSummary }) {
  if (mode === 'waiting')
    return <span className="font-mono text-xs text-warning">Node {row.currentNodeIndex}</span>;
  return <StatusBadge status={row.state} />;
}

function lastValue(mode: OperationalListMode, row: WorkflowExecutionSummary, now: number) {
  if (mode === 'archive') return row.archivedAt ? formatDateTime(row.archivedAt) : 'Unavailable';
  if (mode === 'waiting') return formatDuration(Math.max(0, now - row.updatedAt));
  return formatRelativeTime(row.updatedAt);
}
