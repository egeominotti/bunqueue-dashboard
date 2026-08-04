import type {
  WorkflowExecutionSummary,
  WorkflowStateFilter,
  WorkflowStoreKind,
} from '@/lib/bqTypes';

export interface WorkflowSection {
  id: 'overview' | 'executions' | 'waiting' | 'compensation' | 'archive';
  label: string;
  description: string;
  kind: WorkflowStoreKind;
  state: WorkflowStateFilter | '';
  lockKind?: boolean;
  lockState?: boolean;
}

export const WORKFLOW_SECTIONS: Readonly<Record<string, WorkflowSection>> = {
  '/workflows': {
    id: 'overview',
    label: 'Overview',
    description: 'The complete durable command center for Bunqueue Workflow Engine.',
    kind: 'active',
    state: '',
  },
  '/workflows/executions': {
    id: 'executions',
    label: 'Executions',
    description: 'Inspect every active execution, step record, decision, and nested run.',
    kind: 'active',
    state: '',
  },
  '/workflows/waiting': {
    id: 'waiting',
    label: 'Waiting & Signals',
    description: 'Focus on parked executions and their durable signal payloads.',
    kind: 'active',
    state: 'waiting',
    lockKind: true,
    lockState: true,
  },
  '/workflows/compensation': {
    id: 'compensation',
    label: 'Compensation',
    description: 'See running, completed, skipped, failed, and parked saga compensation outcomes.',
    kind: 'active',
    state: 'compensation',
    lockKind: true,
    lockState: true,
  },
  '/workflows/archive': {
    id: 'archive',
    label: 'Archive',
    description: 'Audit terminal executions retained by Workflow Engine archival.',
    kind: 'archive',
    state: '',
    lockKind: true,
  },
};

export function workflowSectionFor(pathname: string): WorkflowSection {
  return WORKFLOW_SECTIONS[pathname] ?? WORKFLOW_SECTIONS['/workflows'];
}

export interface WorkflowSelection {
  id: string;
  source: 'page' | 'link';
}

/** Keep explicit parent/child inspection stable, but never retain a vanished page row. */
export function reconcileWorkflowSelection(
  current: WorkflowSelection | null,
  rows: readonly Pick<WorkflowExecutionSummary, 'id'>[]
): WorkflowSelection | null {
  if (current?.source === 'link') return current;
  if (current && rows.some((row) => row.id === current.id)) return current;
  return rows[0] ? { id: rows[0].id, source: 'page' } : null;
}
