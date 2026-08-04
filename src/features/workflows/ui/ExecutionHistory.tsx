import { StatusBadge } from '@/components/ui/StatusBadge';
import type { WorkflowExecutionDetail } from '@/lib/bqTypes';
import { formatDateTime } from '@/lib/format';
import { buildExecutionHistory } from '../domain/executionHistory';

export function ExecutionHistory({ execution }: { execution: WorkflowExecutionDetail }) {
  const history = buildExecutionHistory(execution);
  return (
    <ol className="divide-y divide-line/70 border-y border-line/70">
      {history.map((item, index) => (
        <li key={item.id} className="grid grid-cols-[28px_minmax(0,1fr)] gap-3 py-3">
          <div className="relative flex justify-center" aria-hidden="true">
            <span className="mt-1.5 size-2 rounded-full border-2 border-surface bg-accent ring-1 ring-line" />
            {index < history.length - 1 && (
              <span className="absolute top-5 bottom-[-13px] w-px bg-line" />
            )}
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <span className="break-words text-sm font-medium text-fg">{item.title}</span>
              {item.status && <StatusBadge status={item.status} />}
            </div>
            <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-faint">
              <span className="capitalize">{item.category}</span>
              <span>
                {item.at === undefined ? 'Timestamp unavailable' : formatDateTime(item.at)}
              </span>
            </div>
            {item.detail && (
              <p className="mt-1 whitespace-pre-wrap text-xs text-muted">{item.detail}</p>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
