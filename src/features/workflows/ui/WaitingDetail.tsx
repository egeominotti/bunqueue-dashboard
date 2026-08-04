import { ErrorState, LoadingState } from '@/components/ui/feedback';
import { formatDateTime } from '@/lib/format';
import { usePolledData } from '@/lib/usePolledData';
import type { WorkflowControlRepository } from '../application/WorkflowControlRepository';
import type { WorkflowRepository } from '../application/WorkflowRepository';
import {
  LiveWorkflowDuration,
  refreshWorkflowViews,
  type WorkflowClock,
  WorkflowDetailStaleBanner,
} from './WorkflowDetailState';
import { WorkflowSignalControl } from './WorkflowSignalControl';
import { Fact, JsonBlock } from './WorkflowValue';

export function WaitingDetail({
  repository,
  controlRepository,
  id,
  onApplied,
  clock,
  pollIntervalMs = 5000,
}: {
  repository: WorkflowRepository;
  controlRepository: WorkflowControlRepository;
  id: string;
  onApplied?: () => void | Promise<void>;
  clock?: WorkflowClock;
  pollIntervalMs?: number;
}) {
  const { data, error, loading, refetch } = usePolledData(
    () => repository.get(id, 'active'),
    [repository, id],
    { intervalMs: pollIntervalMs }
  );
  if (loading && !data) return <LoadingState label="Loading signal inbox…" />;
  if (error && !data) return <ErrorState error={error} onRetry={refetch} />;
  const execution = data?.execution;
  if (!execution) return null;
  const signals = Object.entries(execution.signals);
  return (
    <>
      <WorkflowDetailStaleBanner error={error} onRetry={refetch} />
      <section className="overflow-hidden rounded-lg border border-line bg-surface">
        <header className="border-b border-line px-4 py-3">
          <div className="text-[11px] uppercase tracking-wider text-warning">Signal inbox</div>
          <h2 className="mt-1 break-all font-mono text-sm font-semibold text-fg">{execution.id}</h2>
        </header>
        <dl className="grid grid-cols-2 gap-3 border-b border-line p-4 text-xs sm:grid-cols-3">
          <Fact label="Waiting at node" value={String(execution.currentNodeIndex)} />
          <Fact
            label="Parked for"
            value={<LiveWorkflowDuration since={execution.updatedAt} clock={clock} />}
          />
          <Fact label="Last transition" value={formatDateTime(execution.updatedAt)} />
        </dl>
        <div className="p-4">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-faint">
            Durable signals
          </h3>
          {signals.length ? (
            signals.map(([name, payload]) => (
              <div key={name} className="mb-3 last:mb-0">
                <div className="mb-1 font-mono text-xs text-warning">{name}</div>
                <JsonBlock value={payload} />
              </div>
            ))
          ) : (
            <p className="text-sm text-muted">
              No signal has been persisted yet. The execution remains parked.
            </p>
          )}
        </div>
        <WorkflowSignalControl
          key={id}
          repository={controlRepository}
          executionId={id}
          onApplied={() => refreshWorkflowViews(refetch, onApplied)}
        />
      </section>
    </>
  );
}
