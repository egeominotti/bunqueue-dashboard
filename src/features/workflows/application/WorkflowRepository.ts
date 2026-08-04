import type {
  WorkflowExecutionDetail,
  WorkflowExecutionSummary,
  WorkflowExecutionsPage,
  WorkflowStateFilter,
  WorkflowStats,
  WorkflowStoreKind,
} from '@/lib/bqTypes';

export interface WorkflowListQuery {
  kind: WorkflowStoreKind;
  workflowName?: string;
  state?: WorkflowStateFilter;
  limit: number;
  offset: number;
}

export interface WorkflowRepository {
  stats(): Promise<WorkflowStats>;
  list(query: WorkflowListQuery): Promise<WorkflowExecutionsPage>;
  get(
    id: string,
    kind: WorkflowStoreKind
  ): Promise<{ ok: boolean; execution: WorkflowExecutionDetail }>;
}

export interface WorkflowSnapshot {
  stats: WorkflowStats;
  page: WorkflowExecutionsPage;
}

const ATTENTION_STATES = ['waiting', 'failed', 'compensation-stuck'] as const;

export async function loadWorkflowSnapshot(
  repository: WorkflowRepository,
  query: WorkflowListQuery
): Promise<WorkflowSnapshot> {
  const [stats, page] = await Promise.all([repository.stats(), repository.list(query)]);
  return { stats, page };
}

/**
 * Load a bounded, truthful overview. Each attention state is queried directly,
 * so unrelated recent runs can never hide an older execution that needs an
 * operator. Per-state totals remain exact while the merged list stays bounded.
 */
export async function loadWorkflowOverviewSnapshot(
  repository: WorkflowRepository,
  limit: number
): Promise<WorkflowSnapshot> {
  const [stats, ...pages] = await Promise.all([
    repository.stats(),
    ...ATTENTION_STATES.map((state) =>
      repository.list({ kind: 'active', state, limit, offset: 0 })
    ),
  ]);
  const executions = pages
    .flatMap((page) => page.executions)
    .sort(compareNewestExecution)
    .slice(0, limit);
  return {
    stats,
    page: {
      ok: pages.every((page) => page.ok),
      available: pages.every((page) => page.available),
      executions,
      total: pages.reduce((total, page) => total + page.total, 0),
      limit,
      offset: 0,
    },
  };
}

function compareNewestExecution(
  left: WorkflowExecutionSummary,
  right: WorkflowExecutionSummary
): number {
  return right.createdAt - left.createdAt || right.id.localeCompare(left.id);
}
