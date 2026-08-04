import { ErrorState, LoadingState } from '@/components/ui/feedback';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { formatDateTime } from '@/lib/format';
import { usePolledData } from '@/lib/usePolledData';
import type { WorkflowControlRepository } from '../application/WorkflowControlRepository';
import type { WorkflowRepository } from '../application/WorkflowRepository';
import { WorkflowCompensationControls } from './WorkflowCompensationControls';
import { refreshWorkflowViews, WorkflowDetailStaleBanner } from './WorkflowDetailState';

export function CompensationDetail({
  repository,
  controlRepository,
  id,
  onApplied,
  pollIntervalMs = 5000,
}: {
  repository: WorkflowRepository;
  controlRepository: WorkflowControlRepository;
  id: string;
  onApplied?: () => void | Promise<void>;
  pollIntervalMs?: number;
}) {
  const { data, error, loading, refetch } = usePolledData(
    () => repository.get(id, 'active'),
    [repository, id],
    { intervalMs: pollIntervalMs }
  );
  if (loading && !data) return <LoadingState label="Loading recovery plan…" />;
  if (error && !data) return <ErrorState error={error} onRetry={refetch} />;
  const execution = data?.execution;
  if (!execution) return null;
  const compensations = Object.entries(execution.steps).filter(
    ([, step]) => step.compensatable || step.compensation
  );
  return (
    <>
      <WorkflowDetailStaleBanner error={error} onRetry={refetch} />
      <section className="overflow-hidden rounded-lg border border-line bg-surface">
        <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-violet-400">
              Recovery plan
            </div>
            <h2 className="mt-1 break-all font-mono text-sm font-semibold text-fg">
              {execution.id}
            </h2>
          </div>
          <StatusBadge status={execution.state} />
        </header>
        <div className="grid grid-cols-2 gap-3 border-b border-line p-4 text-xs">
          <div>
            <div className="text-faint">Compensation pivot</div>
            <div className="mt-1 text-fg">
              {execution.committedAt === undefined
                ? 'Not committed'
                : `Node ${execution.committedAt}`}
            </div>
          </div>
          <div>
            <div className="text-faint">Rollback state</div>
            <div className="mt-1 text-fg">{execution.rollbackStatus ?? execution.state}</div>
          </div>
        </div>
        {execution.failureReason && (
          <div
            role="alert"
            className="border-b border-danger/30 bg-danger/[0.06] px-4 py-3 text-xs text-danger"
          >
            {execution.failureReason}
          </div>
        )}
        <div className="p-4">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-faint">
            Compensation ledger
          </h3>
          {compensations.length ? (
            <ol className="space-y-2">
              {compensations.reverse().map(([name, step]) => (
                <li
                  key={name}
                  className="grid gap-2 rounded-md border border-line px-3 py-2 text-xs sm:grid-cols-[1fr_auto]"
                >
                  <div>
                    <div className="font-mono text-fg">{name}</div>
                    <div className="mt-1 text-faint">
                      {step.compensation?.error ?? 'Compensation handler registered'}
                    </div>
                  </div>
                  <div className="text-right text-muted">
                    {step.compensation ? step.compensation.status : 'pending'}
                    {step.compensation?.at ? (
                      <div className="mt-1 text-[10px] text-faint">
                        {formatDateTime(step.compensation.at)}
                      </div>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-sm text-muted">No compensatable step was persisted.</p>
          )}
        </div>
        <WorkflowCompensationControls
          key={id}
          repository={controlRepository}
          executionId={id}
          stuck={execution.state === 'compensation-stuck'}
          onApplied={() => refreshWorkflowViews(refetch, onApplied)}
        />
      </section>
    </>
  );
}
