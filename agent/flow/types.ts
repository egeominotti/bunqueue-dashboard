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

export interface FlowJobTarget {
  id: string;
  queueName: string;
}
