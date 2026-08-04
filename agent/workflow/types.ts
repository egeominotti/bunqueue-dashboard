export const WORKFLOW_STATES = [
  'running',
  'waiting',
  'completed',
  'failed',
  'compensating',
  'compensation-stuck',
] as const;

export type WorkflowExecutionState = (typeof WORKFLOW_STATES)[number];
export type WorkflowStateFilter = WorkflowExecutionState | 'compensation';
export type WorkflowStoreKind = 'active' | 'archive';

export const WORKFLOW_LIMITS = {
  page: 100,
  offset: 1_000_000,
  filter: 256,
  detailBlob: 4 * 1024 * 1024,
  metaBlob: 256 * 1024,
  jsonNodes: 25_000,
  jsonDepth: 40,
  string: 250_000,
} as const;

export interface WorkflowRow {
  id: string;
  workflow_name: string;
  state: string;
  current_node_index: number;
  created_at: number;
  updated_at: number;
  archived_at?: number | null;
  meta?: Uint8Array | null;
}

export interface WorkflowExecutionSummary {
  id: string;
  workflowName: string;
  state: WorkflowExecutionState;
  currentNodeIndex: number;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
  rollbackStatus?: string;
  failureReason?: string;
  parentExecutionId?: string;
  definitionHash?: string;
}

export interface WorkflowExecutionDetail extends WorkflowExecutionSummary {
  input: unknown;
  steps: Record<string, unknown>;
  resolvedSteps?: string[];
  signals: Record<string, unknown>;
  decisions?: Record<string, unknown>;
  committedAt?: number;
}

export interface WorkflowStats {
  available: boolean;
  activeTotal: number;
  archiveTotal: number;
  states: Record<WorkflowExecutionState, number>;
  workflowNames: string[];
}

export interface WorkflowListOptions {
  kind?: WorkflowStoreKind;
  workflowName?: string;
  state?: WorkflowStateFilter;
  limit?: number;
  offset?: number;
}

export interface WorkflowPage {
  available: boolean;
  executions: WorkflowExecutionSummary[];
  total: number;
  limit: number;
  offset: number;
}
