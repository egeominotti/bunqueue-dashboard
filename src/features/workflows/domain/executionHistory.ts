import type { WorkflowExecutionDetail, WorkflowStepRecord } from '@/lib/bqTypes';

export interface ExecutionHistoryItem {
  id: string;
  at?: number;
  title: string;
  detail?: string;
  status?: string;
  category: 'execution' | 'step' | 'signal' | 'compensation';
}

export function buildExecutionHistory(execution: WorkflowExecutionDetail): ExecutionHistoryItem[] {
  const items: ExecutionHistoryItem[] = [
    {
      id: 'execution-started',
      at: execution.createdAt,
      title: 'Execution started',
      detail: execution.workflowName,
      status: 'running',
      category: 'execution',
    },
  ];
  for (const [name, step] of Object.entries(execution.steps)) {
    items.push(...stepHistory(name, step));
  }
  for (const name of Object.keys(execution.signals)) {
    items.push({
      id: `signal:${name}`,
      title: `Signal persisted: ${name}`,
      detail: 'The store does not expose an exact signal timestamp.',
      category: 'signal',
    });
  }
  if (execution.state !== 'running' && execution.state !== 'waiting') {
    items.push({
      id: 'execution-settled',
      at: execution.updatedAt,
      title: `Execution ${execution.state}`,
      detail: execution.failureReason,
      status: execution.state,
      category: 'execution',
    });
  }
  return items.sort(compareHistory);
}

function stepHistory(name: string, step: WorkflowStepRecord): ExecutionHistoryItem[] {
  const items: ExecutionHistoryItem[] = [];
  if (step.startedAt !== undefined) {
    items.push({
      id: `step:${name}:started`,
      at: step.startedAt,
      title: `Step started: ${name}`,
      detail: step.attempts ? `Attempt ${step.attempts}` : undefined,
      status: 'running',
      category: 'step',
    });
  }
  if (step.completedAt !== undefined || step.status === 'failed') {
    items.push({
      id: `step:${name}:settled`,
      at: step.completedAt,
      title: `Step ${step.status}: ${name}`,
      detail: step.error,
      status: step.status,
      category: 'step',
    });
  }
  if (step.compensation) {
    items.push({
      id: `step:${name}:compensation`,
      at: step.compensation.at,
      title: `Compensation ${step.compensation.status}: ${name}`,
      detail: step.compensation.error,
      status: step.compensation.status,
      category: 'compensation',
    });
  }
  return items;
}

function compareHistory(left: ExecutionHistoryItem, right: ExecutionHistoryItem): number {
  if (left.at === undefined && right.at === undefined) return left.id.localeCompare(right.id);
  if (left.at === undefined) return 1;
  if (right.at === undefined) return -1;
  return left.at - right.at || left.id.localeCompare(right.id);
}
