/**
 * Corrected + extended API types for the full-control surface.
 * Kept separate from the original lib/types.ts (additive; nothing existing is
 * modified). Verified against src/infrastructure/server/httpRoute*.ts.
 */

export interface JobFull {
  id: string;
  queue?: string;
  data?: unknown;
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
  secret: string | null;
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
  queue: string;
  schedule: string | null;
  repeatEvery: number | null;
  nextRun: number;
  executions: number;
  maxLimit: number | null;
  timezone: string | null;
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
export type ServerRunStatus = 'running' | 'stopped' | 'starting' | 'stopping';

export interface ServerConfig {
  command: string;
  httpPort: number;
  tcpPort: number;
  dataPath: string;
  extraEnv: Record<string, string>;
}

/** On-disk footprint of the SQLite database (main file + WAL + SHM sidecars). */
export interface DbStats {
  path: string;
  exists: boolean;
  size: number;
  walSize: number;
  shmSize: number;
  totalSize: number;
  mtimeMs: number | null;
}

export interface ServerStatus {
  status: ServerRunStatus;
  pid: number | null;
  startedAt: number | null;
  exitCode: number | null;
  healthy: boolean;
  version?: string;
  config: ServerConfig;
  /** Config the live process was launched with (null when stopped). */
  runningConfig?: ServerConfig | null;
  /** SQLite on-disk size for the configured data path. */
  db?: DbStats | null;
}

export interface ServerLogLine {
  seq: number;
  ts: number;
  stream: 'stdout' | 'stderr' | 'sys';
  line: string;
}
