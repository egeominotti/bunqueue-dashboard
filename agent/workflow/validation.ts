import { decodeWorkflowObject } from './codec';
import {
  WORKFLOW_LIMITS,
  WORKFLOW_STATES,
  type WorkflowExecutionState,
  type WorkflowExecutionSummary,
  type WorkflowRow,
} from './types';

const STEP_STATES = new Set(['pending', 'running', 'completed', 'failed']);
const COMPENSATION_STATES = new Set([
  'compensated',
  'compensation-failed',
  'compensation-skipped',
]);

export function validWorkflowState(value: string): value is WorkflowExecutionState {
  return (WORKFLOW_STATES as readonly string[]).includes(value);
}

export function assertWorkflowRow(row: WorkflowRow): WorkflowExecutionSummary {
  if (
    typeof row.id !== 'string' ||
    typeof row.workflow_name !== 'string' ||
    row.workflow_name.length < 1 ||
    row.workflow_name.length > WORKFLOW_LIMITS.filter ||
    !validWorkflowState(row.state) ||
    !Number.isSafeInteger(row.current_node_index) ||
    !Number.isFinite(row.created_at) ||
    !Number.isFinite(row.updated_at)
  ) {
    throw new Error('Workflow store contains an invalid execution row');
  }
  const meta = decodeWorkflowObject(row.meta, WORKFLOW_LIMITS.metaBlob, 'meta');
  return {
    id: row.id,
    workflowName: row.workflow_name,
    state: row.state,
    currentNodeIndex: row.current_node_index,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(typeof row.archived_at === 'number' ? { archivedAt: row.archived_at } : {}),
    ...(typeof meta.rollbackStatus === 'string' ? { rollbackStatus: meta.rollbackStatus } : {}),
    ...(typeof meta.failureReason === 'string' ? { failureReason: meta.failureReason } : {}),
    ...(typeof meta.parentExecutionId === 'string' ? { parentExecutionId: meta.parentExecutionId } : {}),
    ...(typeof meta.definitionHash === 'string' ? { definitionHash: meta.definitionHash } : {}),
  };
}

export function assertWorkflowSteps(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Workflow steps must decode to an object');
  }
  for (const [name, candidate] of Object.entries(value)) {
    if (!name || candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('Workflow store contains an invalid step record');
    }
    assertStep(candidate as Record<string, unknown>);
  }
  return value as Record<string, unknown>;
}

function assertStep(step: Record<string, unknown>): void {
  if (
    typeof step.status !== 'string' ||
    !STEP_STATES.has(step.status) ||
    invalidOptionalType(step, 'error', 'string') ||
    invalidOptionalType(step, 'compensatable', 'boolean') ||
    invalidOptionalType(step, 'idempotencyKey', 'string') ||
    invalidOptionalType(step, 'childExecutionId', 'string') ||
    !optionalFinite(step, 'startedAt') ||
    !optionalFinite(step, 'completedAt') ||
    !optionalInteger(step, 'attempts') ||
    !optionalInteger(step, 'loopIndex') ||
    !optionalInteger(step, 'occurrence')
  ) {
    throw new Error('Workflow store contains an invalid step record');
  }
  if (Object.hasOwn(step, 'compensation')) assertCompensation(step.compensation);
}

function assertCompensation(candidate: unknown): void {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error('Workflow store contains an invalid compensation record');
  }
  const compensation = candidate as Record<string, unknown>;
  if (
    typeof compensation.status !== 'string' ||
    !COMPENSATION_STATES.has(compensation.status) ||
    typeof compensation.at !== 'number' ||
    !Number.isFinite(compensation.at) ||
    invalidOptionalType(compensation, 'error', 'string')
  ) {
    throw new Error('Workflow store contains an invalid compensation record');
  }
}

function invalidOptionalType(
  record: Record<string, unknown>,
  key: string,
  type: 'string' | 'boolean'
): boolean {
  return Object.hasOwn(record, key) && typeof record[key] !== type;
}

function optionalFinite(record: Record<string, unknown>, key: string): boolean {
  return !Object.hasOwn(record, key) ||
    (typeof record[key] === 'number' && Number.isFinite(record[key]));
}

function optionalInteger(record: Record<string, unknown>, key: string): boolean {
  return !Object.hasOwn(record, key) ||
    (typeof record[key] === 'number' && Number.isSafeInteger(record[key]) && record[key] >= 0);
}
