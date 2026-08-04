import { useSearchParams } from 'react-router-dom';
import { ErrorState, LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { StatusBadge } from '@/components/ui/StatusBadge';
import type { WorkflowStoreKind } from '@/lib/bqTypes';
import { cn } from '@/lib/cn';
import { usePolledData } from '@/lib/usePolledData';
import type { WorkflowRepository } from '../application/WorkflowRepository';
import { isWorkflowDetailTab, type WorkflowDetailTab } from '../domain/workflowUrlState';
import { ExecutionHistory } from './ExecutionHistory';
import { ExecutionPayloads } from './ExecutionPayloads';
import { ExecutionSummary } from './ExecutionSummary';

const TABS: Array<{ id: WorkflowDetailTab; label: string }> = [
  { id: 'summary', label: 'Summary' },
  { id: 'history', label: 'History' },
  { id: 'payloads', label: 'Payloads' },
];

export function ExecutionDetail({
  repository,
  id,
  kind,
  onSelect,
}: {
  repository: WorkflowRepository;
  id: string;
  kind: WorkflowStoreKind;
  onSelect: (id: string) => void;
}) {
  return (
    <ExecutionDetailContent
      key={`${kind}:${id}`}
      repository={repository}
      id={id}
      kind={kind}
      onSelect={onSelect}
    />
  );
}

function ExecutionDetailContent({
  repository,
  id,
  kind,
  onSelect,
}: {
  repository: WorkflowRepository;
  id: string;
  kind: WorkflowStoreKind;
  onSelect: (id: string) => void;
}) {
  const [params, setParams] = useSearchParams();
  const rawTab = params.get('tab');
  const tab = isWorkflowDetailTab(rawTab) ? rawTab : 'summary';
  const { data, error, loading, refetch } = usePolledData(
    () => repository.get(id, kind),
    [repository, id, kind],
    { intervalMs: 5000 }
  );
  if (loading && !data)
    return (
      <DetailFrame>
        <LoadingState label="Loading execution…" />
      </DetailFrame>
    );
  if (error && !data)
    return (
      <DetailFrame>
        <ErrorState error={error} onRetry={refetch} />
      </DetailFrame>
    );
  const execution = data?.execution;
  if (!execution) return null;
  return (
    <DetailFrame>
      {error && (
        <OfflineBanner
          message="Execution refresh failed. Showing the last snapshot."
          onRetry={refetch}
        />
      )}
      <header className="border-b border-line px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-wider text-faint">Execution</div>
            <h2 translate="no" className="mt-1 break-all font-mono text-sm font-semibold text-fg">
              {execution.id}
            </h2>
            <div className="mt-1 text-xs text-muted">{execution.workflowName}</div>
          </div>
          <StatusBadge status={execution.state} />
        </div>
      </header>
      <nav aria-label="Execution detail" className="flex border-b border-line px-2">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={tab === item.id}
            onClick={() => {
              setParams((current) => {
                const next = new URLSearchParams(current);
                if (item.id === 'summary') next.delete('tab');
                else next.set('tab', item.id);
                return next;
              });
            }}
            className={cn(
              'border-b-2 px-3 py-2 text-xs font-medium',
              tab === item.id
                ? 'border-accent text-fg'
                : 'border-transparent text-faint hover:text-muted'
            )}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div className="p-4" aria-live="polite">
        {tab === 'summary' && <ExecutionSummary execution={execution} onSelect={onSelect} />}
        {tab === 'history' && <ExecutionHistory execution={execution} />}
        {tab === 'payloads' && <ExecutionPayloads execution={execution} />}
      </div>
    </DetailFrame>
  );
}

function DetailFrame({ children }: { children: React.ReactNode }) {
  return (
    <section className="min-w-0 overflow-hidden rounded-lg border border-line bg-surface">
      {children}
    </section>
  );
}
