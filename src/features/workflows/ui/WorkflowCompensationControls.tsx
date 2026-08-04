import { toast } from '@/components/dashboard/stores/toastStore';
import type { WorkflowControlRepository } from '../application/WorkflowControlRepository';
import { useWorkflowCommand } from './useWorkflowCommand';
import { JsonBlock } from './WorkflowValue';

export function WorkflowCompensationControls({
  repository,
  executionId,
  stuck,
  onApplied,
}: {
  repository: WorkflowControlRepository;
  executionId: string;
  stuck: boolean;
  onApplied?: () => void | Promise<void>;
}) {
  const command = useWorkflowCommand({
    scopeKey: `${executionId}:${stuck}`,
    onApplied,
    onSucceeded: (label) =>
      toast.success(
        label === 'resume' ? 'Compensation resumed' : 'Compensation abandoned',
        executionId
      ),
  });
  if (!stuck) return null;
  return (
    <div className="border-t border-line p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-faint">
        Operator decision
      </h3>
      <p className="mt-1 text-xs text-muted">
        Retry after fixing the reversal, or explicitly abandon the remaining compensation steps.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={Boolean(command.busy)}
          onClick={() => {
            if (
              window.confirm(
                `Retry the stuck compensation for ${executionId}? Handlers must be idempotent.`
              )
            ) {
              void command.run('resume', () => repository.resumeCompensation(executionId));
            }
          }}
          className="rounded-md bg-accent px-3 py-2 text-xs font-medium text-accent-fg disabled:opacity-40"
        >
          Resume compensation
        </button>
        <button
          type="button"
          disabled={Boolean(command.busy)}
          onClick={() => {
            if (
              window.confirm(
                `Abandon remaining compensation for ${executionId}? This is irreversible.`
              )
            ) {
              void command.run('abandon', () => repository.abandonCompensation(executionId));
            }
          }}
          className="rounded-md border border-danger/40 px-3 py-2 text-xs text-danger disabled:opacity-40"
        >
          Abandon remainder
        </button>
      </div>
      {command.error && (
        <p role="alert" className="mt-3 text-xs text-danger">
          {command.error}
        </p>
      )}
      {command.succeeded && (
        <p role="status" className="mt-3 text-xs text-success">
          {command.succeeded === 'resume'
            ? 'Resume command accepted; recovery state refreshed.'
            : 'Abandon command accepted; recovery state refreshed.'}
        </p>
      )}
      {command.result !== undefined && (
        <div className="mt-3">
          <JsonBlock value={command.result} />
        </div>
      )}
    </div>
  );
}
