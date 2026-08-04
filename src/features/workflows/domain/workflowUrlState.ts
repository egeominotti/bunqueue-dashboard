import type { WorkflowStateFilter, WorkflowStoreKind } from '@/lib/bqTypes';
import { decodedHttpPathError } from '@/lib/upstreamPaths';
import type { WorkflowSection } from './workflowSections';

export type WorkflowDetailTab = 'summary' | 'history' | 'payloads';
export const WORKFLOW_PAGE_SIZE = 25;

export interface WorkflowUrlState {
  kind: WorkflowStoreKind;
  workflowName: string;
  state: WorkflowStateFilter | '';
  offset: number;
  executionId: string | null;
  tab: WorkflowDetailTab;
}

export type WorkflowUrlPatch = Partial<WorkflowUrlState>;

const DETAIL_TABS = new Set<WorkflowDetailTab>(['summary', 'history', 'payloads']);
const EXECUTION_STATES = new Set<WorkflowStateFilter>([
  'running',
  'waiting',
  'completed',
  'failed',
  'compensating',
  'compensation-stuck',
  'compensation',
]);

export function readWorkflowUrlState(
  params: URLSearchParams,
  section: WorkflowSection
): WorkflowUrlState {
  const rawKind = params.get('kind');
  const kind =
    section.id === 'executions' && (rawKind === 'active' || rawKind === 'archive')
      ? rawKind
      : section.kind;
  const workflowName = section.id === 'overview' ? '' : validWorkflowName(params.get('workflow'));
  const state = workflowState(params.get('state'), section);
  const offset = section.id === 'overview' ? 0 : validOffset(params.get('offset'));
  const rawExecution = params.get('execution');
  const executionId =
    rawExecution && decodedHttpPathError(rawExecution, 'Workflow execution id') === null
      ? rawExecution
      : null;
  const rawTab = params.get('tab');
  const supportsTabs = section.id === 'overview' || section.id === 'executions';
  const tab =
    executionId && supportsTabs && DETAIL_TABS.has(rawTab as WorkflowDetailTab)
      ? (rawTab as WorkflowDetailTab)
      : 'summary';
  return { kind, workflowName, state, offset, executionId, tab };
}

export function workflowSearchParams(
  section: WorkflowSection,
  value: WorkflowUrlState
): URLSearchParams {
  const params = new URLSearchParams();
  if (section.id === 'executions' && value.kind === 'archive') params.set('kind', 'archive');
  if (section.id !== 'overview' && value.workflowName) {
    params.set('workflow', value.workflowName);
  }
  if (supportsStateFilter(section) && value.state) params.set('state', value.state);
  if (section.id !== 'overview' && value.offset > 0) params.set('offset', String(value.offset));
  if (value.executionId) params.set('execution', value.executionId);
  if (
    value.executionId &&
    value.tab !== 'summary' &&
    (section.id === 'overview' || section.id === 'executions')
  ) {
    params.set('tab', value.tab);
  }
  return params;
}

export function patchWorkflowSearchParams(
  params: URLSearchParams,
  section: WorkflowSection,
  patch: WorkflowUrlPatch
): URLSearchParams {
  return workflowSearchParams(section, { ...readWorkflowUrlState(params, section), ...patch });
}

export function isWorkflowDetailTab(value: string | null): value is WorkflowDetailTab {
  return DETAIL_TABS.has(value as WorkflowDetailTab);
}

function validWorkflowName(raw: string | null): string {
  return raw && raw.length <= 256 ? raw : '';
}

function validOffset(raw: string | null): number {
  if (!raw || !/^(0|[1-9]\d*)$/.test(raw)) return 0;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value <= 1_000_000
    ? Math.floor(value / WORKFLOW_PAGE_SIZE) * WORKFLOW_PAGE_SIZE
    : 0;
}

function workflowState(raw: string | null, section: WorkflowSection): WorkflowStateFilter | '' {
  if (!supportsStateFilter(section)) return section.state;
  if (!raw) return '';
  if (section.id === 'archive') return raw === 'completed' || raw === 'failed' ? raw : '';
  return EXECUTION_STATES.has(raw as WorkflowStateFilter) ? (raw as WorkflowStateFilter) : '';
}

function supportsStateFilter(section: WorkflowSection): boolean {
  return section.id === 'executions' || section.id === 'archive';
}
