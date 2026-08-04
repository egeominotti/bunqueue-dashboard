import { StatusBadge } from '@/components/ui/StatusBadge';
import type { WorkflowExecutionDetail } from '@/lib/bqTypes';
import { formatDateTime, formatDuration } from '@/lib/format';
import { StepTimeline } from './StepTimeline';
import { Fact } from './WorkflowValue';

export function ExecutionSummary({
  execution,
  onSelect,
}: {
  execution: WorkflowExecutionDetail;
  onSelect: (id: string) => void;
}) {
  const steps = Object.values(execution.steps);
  const complete = steps.filter((step) => step.status === 'completed').length;
  return (
    <div className="space-y-5">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 border-b border-line pb-5 text-xs sm:grid-cols-3">
        <Fact label="Current node" value={String(execution.currentNodeIndex)} />
        <Fact label="Step progress" value={`${complete}/${steps.length} completed`} />
        <Fact label="Duration" value={formatDuration(execution.updatedAt - execution.createdAt)} />
        <Fact label="Started" value={formatDateTime(execution.createdAt)} />
        <Fact label="Last transition" value={formatDateTime(execution.updatedAt)} />
        <Fact label="Rollback" value={execution.rollbackStatus ?? 'Not started'} />
      </dl>
      {execution.failureReason && (
        <div
          role="alert"
          className="border-l-2 border-danger bg-danger/[0.06] px-3 py-2 text-xs text-danger"
        >
          <div className="mb-1 font-medium">Failure</div>
          <p className="whitespace-pre-wrap">{execution.failureReason}</p>
        </div>
      )}
      <Relationships execution={execution} onSelect={onSelect} />
      <div>
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-faint">
          Step state
        </h3>
        <StepTimeline steps={execution.steps} onSelect={onSelect} />
      </div>
    </div>
  );
}

function Relationships({
  execution,
  onSelect,
}: {
  execution: WorkflowExecutionDetail;
  onSelect: (id: string) => void;
}) {
  if (
    !execution.parentExecutionId &&
    !execution.definitionHash &&
    execution.committedAt === undefined
  )
    return null;
  return (
    <div className="grid gap-3 border-b border-line pb-5 text-xs sm:grid-cols-2">
      {execution.parentExecutionId && (
        <div>
          <div className="text-faint">Parent execution</div>
          <button
            type="button"
            onClick={() => onSelect(execution.parentExecutionId as string)}
            className="mt-1 break-all font-mono text-accent hover:underline"
          >
            {execution.parentExecutionId}
          </button>
        </div>
      )}
      {execution.definitionHash && (
        <Fact label="Definition hash" value={execution.definitionHash} />
      )}
      {execution.committedAt !== undefined && (
        <Fact label="Compensation pivot" value={`Node ${execution.committedAt}`} />
      )}
      <div className="flex items-end">
        <StatusBadge status={execution.state} />
      </div>
    </div>
  );
}
