import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { EmptyState, ErrorState, LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { PageHeader } from '@/components/ui/PageHeader';
import type { WorkflowStoreKind } from '@/lib/bqTypes';
import { usePolledData } from '@/lib/usePolledData';
import type { WorkflowControlRepository } from '../application/WorkflowControlRepository';
import {
  loadWorkflowOverviewSnapshot,
  loadWorkflowSnapshot,
  type WorkflowRepository,
} from '../application/WorkflowRepository';
import {
  reconcileWorkflowSelection,
  type WorkflowSelection,
  workflowSectionFor,
} from '../domain/workflowSections';
import { WORKFLOW_PAGE_SIZE } from '../domain/workflowUrlState';
import { bqWorkflowControlRepository } from '../infrastructure/bqWorkflowControlRepository';
import { bqWorkflowRepository } from '../infrastructure/bqWorkflowRepository';
import { useWorkflowUrlState } from './useWorkflowUrlState';
import { WorkflowMaintenancePanel } from './WorkflowMaintenancePanel';
import { WorkflowMetrics } from './WorkflowMetrics';
import { WorkflowRuntimePanel } from './WorkflowRuntimePanel';
import { WorkflowSectionControls } from './WorkflowSectionControls';
import { WorkflowWorkspace } from './WorkflowWorkspace';

export function WorkflowPage({
  repository = bqWorkflowRepository,
  controlRepository = bqWorkflowControlRepository,
}: {
  repository?: WorkflowRepository;
  controlRepository?: WorkflowControlRepository;
}) {
  const { pathname } = useLocation();
  const section = workflowSectionFor(pathname);
  const view = useWorkflowUrlState(section);
  const { kind, workflowName, state, offset, selected, update, select } = view;

  const query = {
    kind,
    workflowName: workflowName || undefined,
    state: state || undefined,
    limit: WORKFLOW_PAGE_SIZE,
    offset,
  };
  const { data, error, loading, refetch } = usePolledData(
    () =>
      section.id === 'overview'
        ? loadWorkflowOverviewSnapshot(repository, WORKFLOW_PAGE_SIZE)
        : loadWorkflowSnapshot(repository, query),
    [repository, section.id, kind, workflowName, state, offset],
    { intervalMs: 5000 }
  );

  useEffect(() => {
    const total = data?.page.total;
    if (total === undefined || offset === 0) return;
    const lastPage =
      total === 0 ? 0 : Math.floor((total - 1) / WORKFLOW_PAGE_SIZE) * WORKFLOW_PAGE_SIZE;
    if (offset > lastPage) {
      update({ offset: lastPage, executionId: null, tab: 'summary' }, true);
    }
  }, [data?.page.total, offset, update]);

  useEffect(() => {
    const rows = data?.page.executions;
    if (rows) {
      const selectable =
        section.id === 'overview'
          ? rows.filter((row) => ['waiting', 'failed', 'compensation-stuck'].includes(row.state))
          : rows;
      const next = reconcileWorkflowSelection(selected, selectable);
      if (next?.id !== selected?.id) select(next, true);
    }
  }, [data?.page.executions, section.id, selected, select]);
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
      {section.id === 'overview' && (
        <WorkflowRuntimePanel repository={controlRepository} onApplied={refetch} />
      )}
      {section.id === 'archive' && (
        <WorkflowMaintenancePanel repository={controlRepository} onApplied={refetch} />
      )}
      {section.id === 'executions' && stats && <WorkflowMetrics stats={stats} />}
      <WorkflowSectionControls
        section={section}
        kind={kind}
        workflowName={workflowName}
        state={state}
        stats={stats ?? undefined}
        total={page?.total}
        onKind={(value) => {
          view.update({ kind: value, offset: 0, executionId: null, tab: 'summary' }, false);
        }}
        onWorkflowName={(value) => {
          view.update({ workflowName: value, offset: 0, executionId: null, tab: 'summary' }, false);
        }}
        onState={(value) => {
          view.update({ state: value, offset: 0, executionId: null, tab: 'summary' }, false);
        }}
      />
      {error && data && (
        <OfflineBanner
          message="Workflow refresh failed — showing the last snapshot."
          onRetry={refetch}
        />
      )}
      <WorkflowContent
        repository={repository}
        controlRepository={controlRepository}
        section={section}
        stats={stats}
        kind={kind}
        page={page}
        error={error}
        loading={loading}
        dataPresent={Boolean(data)}
        selected={selected}
        offset={offset}
        onRetry={refetch}
        onSelect={(selection) => view.select(selection)}
        onPage={(value) => {
          view.update({ offset: value, executionId: null, tab: 'summary' });
        }}
      />
    </div>
  );
}

function WorkflowContent({
  repository,
  controlRepository,
  section,
  stats,
  kind,
  page,
  error,
  loading,
  dataPresent,
  selected,
  offset,
  onRetry,
  onSelect,
  onPage,
}: {
  repository: WorkflowRepository;
  controlRepository: WorkflowControlRepository;
  section: ReturnType<typeof workflowSectionFor>;
  stats: Awaited<ReturnType<WorkflowRepository['stats']>> | undefined;
  kind: WorkflowStoreKind;
  page: Awaited<ReturnType<WorkflowRepository['list']>> | undefined;
  error: Error | null;
  loading: boolean;
  dataPresent: boolean;
  selected: WorkflowSelection | null;
  offset: number;
  onRetry: () => Promise<void>;
  onSelect: (selection: WorkflowSelection | null) => void;
  onPage: (offset: number) => void;
}) {
  if (error && !dataPresent) return <ErrorState error={error} onRetry={onRetry} />;
  if (loading && !dataPresent) return <LoadingState label="Loading workflows…" />;
  if (!page?.available)
    return (
      <EmptyState
        title="Workflow store not initialized"
        hint="Start a Bunqueue Workflow Engine with this server dataPath; its official workflow_executions tables will appear here automatically."
      />
    );
  if (page.executions.length === 0 && page.total > 0 && offset > 0) {
    return <LoadingState label="Loading workflow page…" />;
  }
  if (page.executions.length === 0)
    return (
      <EmptyState
        title="No executions match these filters"
        hint="Change the store, workflow, or state filter."
      />
    );
  if (!stats) return null;
  return (
    <WorkflowWorkspace
      section={section}
      repository={repository}
      controlRepository={controlRepository}
      kind={kind}
      stats={stats}
      page={page}
      selected={selected}
      offset={offset}
      pageSize={WORKFLOW_PAGE_SIZE}
      onSelect={onSelect}
      onPage={onPage}
      onRefresh={onRetry}
    />
  );
}
