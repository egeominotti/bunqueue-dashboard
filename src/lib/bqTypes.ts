export interface JobFull {
  id: string;
  queue?: string;
  /** First-class job name (Bunqueue protocol v3 / v2.9.0). */
  name?: string;
  data?: unknown;
  /** Terminal value embedded by current job read/list endpoints. */
  returnvalue?: unknown;
  /** Most recent terminal failure message embedded by current job reads. */
  failedReason?: string;
  /** Legacy dashboard alias; new code should prefer returnvalue. */
  result?: unknown;
  priority?: number;
  createdAt?: number;
  runAt?: number;
  startedAt?: number | null;
  completedAt?: number | null;
  attempts?: number;
  maxAttempts?: number;
  backoff?: number;
  backoffConfig?: { type: 'fixed' | 'exponential'; delay: number; maxDelay?: number } | null;
  timeout?: number | null;
  ttl?: number | null;
  progress?: number;
  progressMessage?: string | null;
  stacktrace?: string[] | null;
  customId?: string | null;
  parentId?: string | null;
  childrenIds?: string[];
  dependsOn?: string[];
  tags?: string[];
  groupId?: string | null;
  removeOnComplete?: boolean;
  removeOnFail?: boolean;
  lastHeartbeat?: number;
  stallCount?: number;
  state?: string;
  timeline?: Array<{
    state: string;
    timestamp: number;
    worker?: string;
    error?: string;
    attempt?: number;
  }>;
  [key: string]: unknown;
}

export interface QueueCountsFull {
  waiting: number;
  prioritized: number;
  delayed: number;
  active: number;
  completed: number;
  failed: number;
  'waiting-children': number;
  paused: number;
  [key: string]: number;
}

/** One entry of GET /queues/summary — all queues' counts in a single call. */
export interface QueueSummaryFull {
  name: string;
  paused: boolean;
  counts: {
    waiting: number;
    prioritized: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
  };
}

export interface DlqEntryFull {
  job: JobFull;
  enteredAt: number;
  reason: string;
  error: string | null;
  attempts?: Array<{
    attempt: number;
    startedAt: number;
    failedAt: number;
    reason: string;
    error: string | null;
    duration: number;
  }>;
  retryCount?: number;
  lastRetryAt?: number | null;
  nextRetryAt?: number | null;
  expiresAt?: number | null;
}

export interface DlqStatsFull {
  total: number;
  byReason: Record<string, number>;
  byQueue: Record<string, number>;
  pendingRetry: number;
  expired: number;
  oldestEntry: number | null;
  newestEntry: number | null;
}

export interface WebhookFull {
  id: string;
  url: string;
  events: string[];
  queue: string | null;
  /** Write-only upstream: list responses intentionally omit the secret. */
  secret?: string | null;
  createdAt: number;
  lastTriggered: number | null;
  successCount: number;
  failureCount: number;
  enabled: boolean;
}

export interface WorkerFull {
  id: string;
  name: string;
  queues: string[];
  concurrency: number;
  hostname: string;
  pid: number;
  status: 'active' | 'stale';
  registeredAt: number;
  lastSeen: number;
  activeJobs: number;
  processedJobs: number;
  failedJobs: number;
  currentJob: string | null;
  uptime: number;
}

export interface CronFull {
  name: string;
  /** Name assigned to every job spawned by this scheduler. */
  jobName?: string;
  queue: string;
  schedule: string | null;
  repeatEvery: number | null;
  nextRun: number;
  executions: number;
  maxLimit: number | null;
  timezone: string | null;
  uniqueKey?: string | null;
  dedup?: { ttl?: number; extend?: boolean; replace?: boolean } | null;
  skipMissedOnRestart?: boolean;
  skipIfNoWorker?: boolean;
  preventOverlap?: boolean;
  jobOptions?: {
    maxAttempts?: number;
    backoff?: number | { type: 'fixed' | 'exponential'; delay: number };
    timeout?: number;
    delay?: number;
    stallTimeout?: number;
    removeOnComplete?: boolean;
    removeOnFail?: boolean;
  } | null;
}

export interface StorageStatusFlat {
  diskFull?: boolean;
  error?: string | null;
  since?: number | null;
}

export interface StallConfig {
  enabled: boolean;
  stallInterval: number;
  maxStalls: number;
  gracePeriod: number;
}

export interface DlqConfig {
  autoRetry: boolean;
  autoRetryInterval: number;
  maxAutoRetries: number;
  maxAge: number | null;
  maxEntries: number;
}

// ---- Control agent ----
export type {
  DbStats,
  ServerConfig,
  ServerConfigSnapshot,
  ServerLogLine,
  ServerManagementMode,
  ServerRunStatus,
  ServerStatus,
} from './controlTypes';

// ---- Workflow Engine observability (Bunqueue 2.9.0 persisted contract) ----
export type WorkflowExecutionState =
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'compensating'
  | 'compensation-stuck';

export type WorkflowStoreKind = 'active' | 'archive';
export type WorkflowStateFilter = WorkflowExecutionState | 'compensation';

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

export interface WorkflowCompensationOutcome {
  status: 'compensated' | 'compensation-failed' | 'compensation-skipped';
  at: number;
  error?: string;
}

export interface WorkflowStepRecord {
  status: 'pending' | 'running' | 'completed' | 'failed';
  result?: unknown;
  error?: string;
  startedAt?: number;
  completedAt?: number;
  attempts?: number;
  compensatable?: boolean;
  loopItem?: unknown;
  loopIndex?: number;
  compensation?: WorkflowCompensationOutcome;
  idempotencyKey?: string;
  childExecutionId?: string;
  occurrence?: number;
}

export interface WorkflowExecutionDetail extends WorkflowExecutionSummary {
  input: unknown;
  steps: Record<string, WorkflowStepRecord>;
  resolvedSteps?: string[];
  signals: Record<string, unknown>;
  decisions?: Record<string, unknown>;
  committedAt?: number;
}

export interface WorkflowStats {
  ok: boolean;
  available: boolean;
  activeTotal: number;
  archiveTotal: number;
  states: Record<WorkflowExecutionState, number>;
  workflowNames: string[];
}

export interface WorkflowExecutionsPage {
  ok: boolean;
  available: boolean;
  executions: WorkflowExecutionSummary[];
  total: number;
  limit: number;
  offset: number;
}
