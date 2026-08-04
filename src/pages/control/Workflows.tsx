import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Card, CardHeader } from '@/components/ui/Card';
import { EmptyState, ErrorState, LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { bq } from '@/lib/bq';
import type {
  WorkflowExecutionSummary,
  WorkflowStateFilter,
  WorkflowStepRecord,
  WorkflowStoreKind,
} from '@/lib/bqTypes';
import { cn } from '@/lib/cn';
import { formatDateTime, formatDuration, formatRelativeTime } from '@/lib/format';
import { usePolledData } from '@/lib/usePolledData';

const PAGE_SIZE = 25;
const STATES: Array<WorkflowStateFilter | ''> = [
  '',
  'running',
  'waiting',
  'completed',
  'failed',
  'compensating',
  'compensation-stuck',
  'compensation',
];

export const WORKFLOW_SECTIONS: Record<
  string,
  {
    label: string;
    description: string;
    kind: WorkflowStoreKind;
    state: WorkflowStateFilter | '';
    lockKind?: boolean;
    lockState?: boolean;
  }
> = {
  '/workflows': {
    label: 'Overview',
    description: 'The complete durable command center for Bunqueue Workflow Engine.',
    kind: 'active',
    state: '',
  },
  '/workflows/executions': {
    label: 'Executions',
    description: 'Inspect every active execution, step record, decision, and nested run.',
    kind: 'active',
    state: '',
    lockKind: true,
  },
  '/workflows/waiting': {
    label: 'Waiting & Signals',
    description: 'Focus on parked executions and their durable signal payloads.',
    kind: 'active',
    state: 'waiting',
    lockKind: true,
    lockState: true,
  },
  '/workflows/compensation': {
    label: 'Compensation',
    description: 'See running, completed, skipped, failed, and parked saga compensation outcomes.',
    kind: 'active',
    state: 'compensation',
    lockKind: true,
    lockState: true,
  },
  '/workflows/archive': {
    label: 'Archive',
    description: 'Audit terminal executions retained by Workflow Engine archival.',
    kind: 'archive',
    state: '',
    lockKind: true,
  },
};

export function workflowSectionFor(pathname: string) {
  return WORKFLOW_SECTIONS[pathname] ?? WORKFLOW_SECTIONS['/workflows'];
}

export interface WorkflowSelection {
  id: string;
  source: 'page' | 'link';
}

/** Keep linked parent/child inspection stable, but never retain a vanished page row. */
export function reconcileWorkflowSelection(
  current: WorkflowSelection | null,
  rows: readonly Pick<WorkflowExecutionSummary, 'id'>[]
): WorkflowSelection | null {
  if (current?.source === 'link') return current;
  if (current && rows.some((row) => row.id === current.id)) return current;
  return rows[0] ? { id: rows[0].id, source: 'page' } : null;
}

const json = (value: unknown) => JSON.stringify(value, null, 2) ?? 'null';
const shortId = (id: string) => (id.length > 22 ? `${id.slice(0, 12)}…${id.slice(-7)}` : id);

function Metric({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <Card className="min-w-0">
      <div className="text-xs font-medium uppercase tracking-wider text-faint">{label}</div>
      <div className={cn('mt-2 tnum text-2xl font-semibold text-fg', tone)}>{value}</div>
    </Card>
  );
}

function JsonBlock({ value, empty = 'None' }: { value: unknown; empty?: string }) {
  const absent = value == null || (typeof value === 'object' && Object.keys(value).length === 0);
  if (absent) return <p className="text-xs text-faint">{empty}</p>;
  return (
    <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-surface-2 p-3 font-mono text-xs leading-5 text-muted">
      {json(value)}
    </pre>
  );
}

function StepTimeline({
  steps,
  onSelect,
}: {
  steps: Record<string, WorkflowStepRecord>;
  onSelect: (id: string) => void;
}) {
  const entries = Object.entries(steps);
  if (entries.length === 0) return <p className="text-xs text-faint">No persisted step records.</p>;
  return (
    <ol className="space-y-3">
      {entries.map(([name, step], index) => {
        const duration =
          step.startedAt !== undefined && step.completedAt !== undefined
            ? step.completedAt - step.startedAt
            : undefined;
        return (
          <li key={name} className="relative grid grid-cols-[18px_1fr] gap-3">
            <div className="flex flex-col items-center" aria-hidden="true">
              <span className="mt-1 size-2.5 rounded-full bg-current text-accent" />
              {index < entries.length - 1 && <span className="mt-1 w-px flex-1 bg-line" />}
            </div>
            <div className="min-w-0 rounded-lg border border-line bg-surface-2 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span translate="no" className="break-all font-mono text-sm font-medium text-fg">
                  {name}
                </span>
                <StatusBadge status={step.status} />
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-faint">
                {step.attempts !== undefined && (
                  <span>
                    {step.attempts} attempt{step.attempts === 1 ? '' : 's'}
                  </span>
                )}
                {duration !== undefined && <span>{formatDuration(duration)}</span>}
                {step.occurrence !== undefined && <span>Occurrence {step.occurrence}</span>}
                {step.loopIndex !== undefined && <span>Loop index {step.loopIndex}</span>}
                {step.compensatable && <span>Compensatable</span>}
              </div>
              {step.idempotencyKey && (
                <div className="mt-2 break-all font-mono text-[11px] text-faint">
                  Idempotency: {step.idempotencyKey}
                </div>
              )}
              {step.childExecutionId && (
                <button
                  type="button"
                  onClick={() => onSelect(step.childExecutionId as string)}
                  className="mt-2 break-all font-mono text-xs text-accent hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  Child execution: {step.childExecutionId}
                </button>
              )}
              {step.error && (
                <p role="alert" className="mt-2 whitespace-pre-wrap text-xs text-danger">
                  {step.error}
                </p>
              )}
              {step.compensation && (
                <div className="mt-3 rounded-md border border-line px-3 py-2 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-faint">Compensation</span>
                    <StatusBadge status={step.compensation.status} />
                    <span className="text-faint">{formatDateTime(step.compensation.at)}</span>
                  </div>
                  {step.compensation.error && (
                    <p className="mt-2 whitespace-pre-wrap text-danger">
                      {step.compensation.error}
                    </p>
                  )}
                </div>
              )}
              {Object.hasOwn(step, 'result') && (
                <details className="mt-3">
                  <summary className="cursor-pointer text-xs text-muted">Result</summary>
                  <div className="mt-2">
                    <JsonBlock value={step.result} />
                  </div>
                </details>
              )}
              {Object.hasOwn(step, 'loopItem') && (
                <details className="mt-3">
                  <summary className="cursor-pointer text-xs text-muted">Loop item</summary>
                  <div className="mt-2">
                    <JsonBlock value={step.loopItem} />
                  </div>
                </details>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function DetailPanel({
  id,
  kind,
  onSelect,
}: {
  id: string;
  kind: WorkflowStoreKind;
  onSelect: (id: string) => void;
}) {
  const { data, error, loading, refetch } = usePolledData(
    () => bq.workflows.get(id, kind),
    [id, kind],
    { intervalMs: 5000 }
  );
  if (loading && !data)
    return (
      <Card>
        <LoadingState label="Loading execution…" />
      </Card>
    );
  if (error && !data) return <ErrorState error={error} onRetry={refetch} />;
  const execution = data?.execution;
  if (!execution) return null;
  const steps = Object.values(execution.steps);
  const complete = steps.filter((step) => step.status === 'completed').length;
  return (
    <div className="space-y-4" aria-live="polite">
      {error && (
        <OfflineBanner
          message="Execution refresh failed — showing the last snapshot."
          onRetry={refetch}
        />
      )}
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs text-faint">Execution</div>
            <h2 translate="no" className="break-all font-mono text-sm font-semibold text-fg">
              {execution.id}
            </h2>
            <div className="mt-1 text-sm text-muted">{execution.workflowName}</div>
          </div>
          <StatusBadge status={execution.state} />
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-3 text-xs sm:grid-cols-3">
          <Fact label="Node" value={String(execution.currentNodeIndex)} />
          <Fact label="Steps" value={`${complete}/${steps.length} completed`} />
          <Fact label="Updated" value={formatDateTime(execution.updatedAt)} />
          <Fact
            label="Duration"
            value={formatDuration(execution.updatedAt - execution.createdAt)}
          />
          <Fact label="Rollback" value={execution.rollbackStatus ?? '—'} />
          <Fact
            label="Pivot"
            value={
              execution.committedAt === undefined
                ? 'Not committed'
                : `Node ${execution.committedAt}`
            }
          />
        </dl>
        {execution.failureReason && (
          <p
            role="alert"
            className="mt-4 whitespace-pre-wrap rounded-lg bg-danger/10 p-3 text-xs text-danger"
          >
            {execution.failureReason}
          </p>
        )}
        {execution.parentExecutionId && (
          <button
            type="button"
            onClick={() => onSelect(execution.parentExecutionId as string)}
            className="mt-3 break-all font-mono text-xs text-accent hover:underline"
          >
            Parent: {execution.parentExecutionId}
          </button>
        )}
        {execution.definitionHash && (
          <div className="mt-3 break-all font-mono text-[11px] text-faint">
            Definition: {execution.definitionHash}
          </div>
        )}
      </Card>
      <Card>
        <CardHeader title="Step timeline" />
        <StepTimeline steps={execution.steps} onSelect={onSelect} />
      </Card>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Input" />
          <JsonBlock value={execution.input} />
        </Card>
        <Card>
          <CardHeader title="Signals" />
          <JsonBlock value={execution.signals} />
        </Card>
        <Card>
          <CardHeader title="Resolved steps" />
          <JsonBlock value={execution.resolvedSteps} />
        </Card>
        <Card>
          <CardHeader title="Decisions" />
          <JsonBlock value={execution.decisions} />
        </Card>
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-faint">{label}</dt>
      <dd className="mt-0.5 break-words text-muted">{value}</dd>
    </div>
  );
}

export function Workflows() {
  const { pathname } = useLocation();
  const section = workflowSectionFor(pathname);
  const [kind, setKind] = useState<WorkflowStoreKind>(section.kind);
  const [workflowName, setWorkflowName] = useState('');
  const [state, setState] = useState<WorkflowStateFilter | ''>(section.state);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<WorkflowSelection | null>(null);

  useEffect(() => {
    setKind(section.kind);
    setState(section.state);
    setWorkflowName('');
    setOffset(0);
    setSelected(null);
  }, [section]);

  const { data, error, loading, refetch } = usePolledData(
    async () => {
      const [stats, page] = await Promise.all([
        bq.workflows.stats(),
        bq.workflows.list({
          kind,
          workflowName: workflowName || undefined,
          state: state || undefined,
          limit: PAGE_SIZE,
          offset,
        }),
      ]);
      return { stats, page };
    },
    [kind, workflowName, state, offset],
    { intervalMs: 5000 }
  );

  useEffect(() => {
    const rows = data?.page.executions;
    if (rows) setSelected((current) => reconcileWorkflowSelection(current, rows));
  }, [data?.page.executions]);

  const reset = () => setOffset(0);
  const stats = data?.stats;
  const page = data?.page;

  return (
    <div>
      <PageHeader
        title={
          <>
            Workflow <span className="text-faint">/ {section.label}</span>
          </>
        }
        description={section.description}
        live={Boolean(data && !error)}
        actions={
          <button
            type="button"
            onClick={() => void refetch()}
            className="rounded-lg border border-line px-3 py-1.5 text-sm text-muted hover:bg-surface-2 hover:text-fg"
          >
            Refresh
          </button>
        }
      />

      <div className="mb-5 rounded-xl border border-blue-500/20 bg-blue-500/[0.06] px-4 py-3 text-sm text-muted">
        <span className="font-medium text-fg">Read-only by contract.</span> Bunqueue does not expose
        Workflow Engine control over HTTP. Start, signal, recovery, and compensation decisions
        require the live Engine with its registered handlers; direct database writes would be
        unsafe.
      </div>

      {stats && (
        <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
          <Metric label="Active store" value={stats.activeTotal} />
          <Metric label="Running" value={stats.states.running} tone="text-blue-400" />
          <Metric label="Waiting" value={stats.states.waiting} tone="text-warning" />
          <Metric label="Completed" value={stats.states.completed} tone="text-success" />
          <Metric label="Failed" value={stats.states.failed} tone="text-danger" />
          <Metric label="Compensating" value={stats.states.compensating} tone="text-violet-400" />
          <Metric label="Stuck" value={stats.states['compensation-stuck']} tone="text-danger" />
        </div>
      )}

      <Card className="mb-5">
        <div className="flex flex-wrap items-end gap-3">
          {section.lockKind ? (
            <div>
              <span className="mb-1 block text-xs text-faint">Store</span>
              <span className="inline-flex h-9 items-center rounded-lg border border-line bg-surface-2 px-3 text-xs capitalize text-fg">
                {section.kind}
                {section.kind === 'archive' && stats ? ` · ${stats.archiveTotal}` : ''}
              </span>
            </div>
          ) : (
            <div>
              <span className="mb-1 block text-xs text-faint">Store</span>
              <div className="flex rounded-lg border border-line p-0.5">
                {(['active', 'archive'] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={kind === value}
                    onClick={() => {
                      setKind(value);
                      setSelected(null);
                      reset();
                    }}
                    className={cn(
                      'rounded-md px-3 py-1.5 text-xs capitalize',
                      kind === value ? 'bg-surface-2 text-fg' : 'text-muted hover:text-fg'
                    )}
                  >
                    {value}
                    {value === 'archive' && stats ? ` (${stats.archiveTotal})` : ''}
                  </button>
                ))}
              </div>
            </div>
          )}
          <label className="text-xs text-faint">
            Workflow
            <select
              value={workflowName}
              onChange={(event) => {
                setWorkflowName(event.target.value);
                setSelected(null);
                reset();
              }}
              className="mt-1 block h-9 min-w-48 rounded-lg border border-line bg-surface-2 px-3 text-sm text-fg"
            >
              <option value="">All workflows</option>
              {stats?.workflowNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          {section.lockState ? (
            <div>
              <span className="mb-1 block text-xs text-faint">State scope</span>
              <span className="inline-flex h-9 items-center rounded-lg border border-line bg-surface-2 px-3 text-xs text-fg">
                {section.state === 'compensation' ? 'Compensating + stuck' : section.state}
              </span>
            </div>
          ) : (
            <label className="text-xs text-faint">
              State
              <select
                value={state}
                onChange={(event) => {
                  setState(event.target.value as WorkflowStateFilter | '');
                  setSelected(null);
                  reset();
                }}
                className="mt-1 block h-9 min-w-44 rounded-lg border border-line bg-surface-2 px-3 text-sm text-fg"
              >
                {STATES.map((value) => (
                  <option key={value || 'all'} value={value}>
                    {value === 'compensation' ? 'All compensation' : value || 'All states'}
                  </option>
                ))}
              </select>
            </label>
          )}
          {page && (
            <span className="ml-auto text-xs text-faint">
              {page.total} execution{page.total === 1 ? '' : 's'}
            </span>
          )}
        </div>
      </Card>

      {error && data && (
        <OfflineBanner
          message="Workflow refresh failed — showing the last snapshot."
          onRetry={refetch}
        />
      )}
      {error && !data ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : loading && !data ? (
        <LoadingState label="Loading workflows…" />
      ) : !page?.available ? (
        <EmptyState
          title="Workflow store not initialized"
          hint="Start a Bunqueue Workflow Engine with this server dataPath; its official workflow_executions tables will appear here automatically."
        />
      ) : page.executions.length === 0 ? (
        <EmptyState
          title="No executions match these filters"
          hint="Change the store, workflow, or state filter."
        />
      ) : (
        <div className="grid gap-5 xl:grid-cols-[minmax(390px,0.8fr)_minmax(0,1.4fr)]">
          <div>
            <div className="overflow-hidden rounded-xl border border-line bg-surface">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-faint">
                    <th className="px-4 py-3 font-medium">Execution</th>
                    <th className="px-4 py-3 font-medium">State</th>
                    <th className="px-4 py-3 text-right font-medium">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {page.executions.map((execution: WorkflowExecutionSummary) => (
                    <tr
                      key={execution.id}
                      className={cn(
                        'border-b border-line/70 last:border-0',
                        selected?.id === execution.id && 'bg-surface-2'
                      )}
                    >
                      <td className="p-0">
                        <button
                          type="button"
                          onClick={() => setSelected({ id: execution.id, source: 'page' })}
                          className="block w-full px-4 py-3 text-left focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-accent"
                        >
                          <span className="block truncate font-medium text-fg">
                            {execution.workflowName}
                          </span>
                          <span
                            translate="no"
                            title={execution.id}
                            className="mt-0.5 block font-mono text-[11px] text-faint"
                          >
                            {shortId(execution.id)}
                          </span>
                        </button>
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={execution.state} />
                      </td>
                      <td
                        title={formatDateTime(execution.updatedAt)}
                        className="whitespace-nowrap px-4 py-3 text-right text-xs text-muted"
                      >
                        {formatRelativeTime(execution.updatedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-3 flex items-center justify-between">
              <button
                type="button"
                disabled={offset === 0}
                onClick={() => {
                  setSelected(null);
                  setOffset(Math.max(0, offset - PAGE_SIZE));
                }}
                className="rounded-lg border border-line px-3 py-1.5 text-xs text-muted disabled:opacity-40"
              >
                Previous
              </button>
              <span className="text-xs text-faint">
                {offset + 1}–{Math.min(offset + PAGE_SIZE, page.total)} of {page.total}
              </span>
              <button
                type="button"
                disabled={offset + PAGE_SIZE >= page.total}
                onClick={() => {
                  setSelected(null);
                  setOffset(offset + PAGE_SIZE);
                }}
                className="rounded-lg border border-line px-3 py-1.5 text-xs text-muted disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
          {selected && (
            <DetailPanel
              id={selected.id}
              kind={kind}
              onSelect={(id) => setSelected({ id, source: 'link' })}
            />
          )}
        </div>
      )}
    </div>
  );
}
