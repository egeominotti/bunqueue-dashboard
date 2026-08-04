export type FlowCreateOperation = 'add' | 'addBulk' | 'addChain' | 'addBulkThen' | 'addTree';
export type FlowInspectOperation =
  | 'getState'
  | 'isWaiting'
  | 'isActive'
  | 'isDelayed'
  | 'isCompleted'
  | 'isFailed'
  | 'isWaitingChildren'
  | 'toJSON'
  | 'asJSON'
  | 'getChildrenValues'
  | 'getDependencies'
  | 'getDependenciesCount'
  | 'getFailedChildrenValues'
  | 'getIgnoredChildrenFailures';
export type FlowMutationOperation =
  | 'removeChildDependency'
  | 'removeUnprocessedChildren'
  | 'updateData'
  | 'updateProgress'
  | 'log'
  | 'changeDelay'
  | 'changePriority'
  | 'clearLogs'
  | 'removeDeduplicationKey'
  | 'retry'
  | 'promote'
  | 'remove';

export interface FlowTarget {
  id: string;
  queueName: string;
}

export interface FlowOperationsRepository {
  create(operation: FlowCreateOperation, payload: Record<string, unknown>): Promise<unknown>;
  getFlow(target: FlowTarget & { depth?: number; maxChildren?: number }): Promise<unknown>;
  inspect(target: FlowTarget, operation: FlowInspectOperation): Promise<unknown>;
  getParentResult(parentId: string): Promise<unknown>;
  getParentResults(parentIds: readonly string[]): Promise<unknown>;
  waitUntilFinished(target: FlowTarget, ttl: number): Promise<unknown>;
  mutate(
    target: FlowTarget,
    operation: FlowMutationOperation,
    payload?: Record<string, unknown>
  ): Promise<unknown>;
}
