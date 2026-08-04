import { StatusBadge } from '@/components/ui/StatusBadge';
import type { WorkflowExecutionSummary } from '@/lib/bqTypes';
import { cn } from '@/lib/cn';
import { formatDateTime, formatDuration, formatRelativeTime } from '@/lib/format';
import type { WorkflowSelection } from '../domain/workflowSections';
import { WorkflowPagination } from './WorkflowPagination';

const shortId = (id: string) => (id.length > 22 ? `${id.slice(0, 12)}…${id.slice(-7)}` : id);

export function ExecutionList({
  executions,
  total,
  offset,
  pageSize,
  selected,
  onSelect,
  onPage,
}: {
  executions: WorkflowExecutionSummary[];
  total: number;
  offset: number;
  pageSize: number;
  selected: WorkflowSelection | null;
  onSelect: (selection: WorkflowSelection) => void;
  onPage: (offset: number) => void;
}) {
  return (
    <div>
      <div className="overflow-x-auto rounded-lg border border-line bg-surface">
        <table className="w-full text-sm">
          <thead className="bg-surface-2/80">
            <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-faint">
              <th className="px-3 py-2 font-medium">Workflow / execution</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="hidden px-3 py-2 font-medium md:table-cell">Node</th>
              <th className="hidden px-3 py-2 font-medium lg:table-cell">Elapsed</th>
              <th className="px-3 py-2 text-right font-medium">Updated</th>
            </tr>
          </thead>
          <tbody>
            {executions.map((execution) => (
              <ExecutionRow
                key={execution.id}
                execution={execution}
                selected={selected?.id === execution.id}
                onSelect={onSelect}
              />
            ))}
          </tbody>
        </table>
      </div>
      <WorkflowPagination
        total={total}
        offset={offset}
        pageSize={pageSize}
        count={executions.length}
        onPage={onPage}
      />
    </div>
  );
}

function ExecutionRow({
  execution,
  selected,
  onSelect,
}: {
  execution: WorkflowExecutionSummary;
  selected: boolean;
  onSelect: (selection: WorkflowSelection) => void;
}) {
  return (
    <tr className={cn('border-b border-line/70 last:border-0', selected && 'bg-surface-2')}>
      <td className="p-0">
        <button
          type="button"
          onClick={() => onSelect({ id: execution.id, source: 'page' })}
          className="block w-full px-3 py-2.5 text-left focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-accent"
        >
          <span className="block truncate font-medium text-fg">{execution.workflowName}</span>
          <span
            translate="no"
            title={execution.id}
            className="mt-0.5 block font-mono text-[11px] text-faint"
          >
            {shortId(execution.id)}
          </span>
        </button>
      </td>
      <td className="px-3 py-2.5">
        <StatusBadge status={execution.state} />
      </td>
      <td className="hidden px-3 py-2.5 font-mono text-xs text-muted md:table-cell">
        {execution.currentNodeIndex}
      </td>
      <td className="hidden whitespace-nowrap px-3 py-2.5 font-mono text-xs text-muted lg:table-cell">
        {formatDuration(execution.updatedAt - execution.createdAt)}
      </td>
      <td
        title={formatDateTime(execution.updatedAt)}
        className="whitespace-nowrap px-3 py-2.5 text-right text-xs text-muted"
      >
        {formatRelativeTime(execution.updatedAt)}
      </td>
    </tr>
  );
}
