import { ErrorState, LoadingState } from '@/components/ui/feedback';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { formatDateTime, formatDuration } from '@/lib/format';
import { usePolledData } from '@/lib/usePolledData';
import type { WorkflowRepository } from '../application/WorkflowRepository';
import { ExecutionHistory } from './ExecutionHistory';
import { WorkflowDetailStaleBanner } from './WorkflowDetailState';
import { Fact } from './WorkflowValue';

export function ArchiveDetail({
  repository,
  id,
  pollIntervalMs = 10000,
}: {
  repository: WorkflowRepository;
  id: string;
  pollIntervalMs?: number;
}) {
  const { data, error, loading, refetch } = usePolledData(
    () => repository.get(id, 'archive'),
    [repository, id],
    { intervalMs: pollIntervalMs }
  );
  if (loading && !data) return <LoadingState label="Loading audit record…" />;
  if (error && !data) return <ErrorState error={error} onRetry={refetch} />;
  const execution = data?.execution;
  if (!execution) return null;
  return (
    <>
      <WorkflowDetailStaleBanner error={error} onRetry={refetch} />
      <section className="overflow-hidden rounded-lg border border-line bg-surface">
        <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-faint">
              Immutable audit record
            </div>
            <h2 className="mt-1 break-all font-mono text-sm font-semibold text-fg">
              {execution.id}
            </h2>
          </div>
          <StatusBadge status={execution.state} />
        </header>
        <dl className="grid grid-cols-2 gap-3 border-b border-line p-4 text-xs sm:grid-cols-3">
          <Fact label="Workflow" value={execution.workflowName} />
          <Fact label="Runtime" value={formatDuration(execution.updatedAt - execution.createdAt)} />
          <Fact
            label="Archived"
            value={execution.archivedAt ? formatDateTime(execution.archivedAt) : 'Unavailable'}
          />
          <Fact label="Definition hash" value={execution.definitionHash ?? 'Unavailable'} />
          <Fact label="Final node" value={String(execution.currentNodeIndex)} />
          <Fact label="Final transition" value={formatDateTime(execution.updatedAt)} />
        </dl>
        <div className="p-4">
          <ExecutionHistory execution={execution} />
        </div>
      </section>
    </>
  );
}
