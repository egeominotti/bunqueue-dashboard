import type { WorkflowExecutionSummary, WorkflowStats } from '@/lib/bqTypes';
import { formatRelativeTime } from '@/lib/format';
import type { WorkflowSelection } from '../domain/workflowSections';
import { ExecutionDetail } from './ExecutionDetail';
import type { WorkspaceProps } from './WorkflowWorkspace';

export function OverviewWorkspace({
  stats,
  page,
  repository,
  kind,
  selected,
  onSelect,
}: WorkspaceProps) {
  const attention = page.executions.filter((item) =>
    ['waiting', 'failed', 'compensation-stuck'].includes(item.state)
  );
  return (
    <div className="space-y-5">
      <OverviewPulse stats={stats} />
      <div className="grid gap-5 xl:grid-cols-[minmax(320px,0.7fr)_minmax(0,1.3fr)]">
        <section className="rounded-lg border border-line bg-surface">
          <header className="border-b border-line px-4 py-3">
            <h2 className="text-sm font-semibold text-fg">Needs attention</h2>
            <p className="mt-0.5 text-xs text-faint">
              Waiting, failed, and stuck executions · showing {attention.length} of {page.total}.
            </p>
          </header>
          <AttentionList rows={attention} selected={selected} onSelect={onSelect} />
        </section>
        {selected && (
          <ExecutionDetail
            repository={repository}
            id={selected.id}
            kind={kind}
            onSelect={(id) => onSelect({ id, source: 'link' })}
          />
        )}
      </div>
    </div>
  );
}

function OverviewPulse({ stats }: { stats: WorkflowStats }) {
  const items = [
    ['Open executions', stats.activeTotal],
    ['Waiting for signal', stats.states.waiting],
    ['Recovery required', stats.states['compensation-stuck'] + stats.states.failed],
    ['Retained in archive', stats.archiveTotal],
  ];
  return (
    <dl className="grid overflow-hidden rounded-lg border border-line bg-surface sm:grid-cols-2 xl:grid-cols-4">
      {items.map(([label, value]) => (
        <div key={label} className="border-b border-line px-4 py-3 sm:border-r xl:border-b-0">
          <dt className="text-[10px] uppercase tracking-wider text-faint">{label}</dt>
          <dd className="mt-1 font-mono text-xl font-semibold text-fg">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function AttentionList({
  rows,
  selected,
  onSelect,
}: {
  rows: WorkflowExecutionSummary[];
  selected: WorkflowSelection | null;
  onSelect: (value: WorkflowSelection) => void;
}) {
  if (!rows.length)
    return <p className="px-4 py-8 text-center text-sm text-muted">No intervention required.</p>;
  return (
    <ul className="divide-y divide-line">
      {rows.map((row) => (
        <li key={row.id} className={selected?.id === row.id ? 'bg-surface-2' : undefined}>
          <button
            type="button"
            className="w-full px-4 py-3 text-left"
            onClick={() => onSelect({ id: row.id, source: 'page' })}
          >
            <span className="flex items-center justify-between gap-3">
              <span className="truncate text-sm font-medium text-fg">{row.workflowName}</span>
              <span className="text-xs text-faint">{formatRelativeTime(row.updatedAt)}</span>
            </span>
            <span className="mt-1 flex items-center justify-between gap-3 font-mono text-[11px] text-faint">
              <span className="truncate">{row.id}</span>
              <span>{row.state}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
