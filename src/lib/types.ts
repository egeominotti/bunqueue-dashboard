/**
 * Types mirroring the bunqueue HTTP API response shapes.
 * Source of truth: src/infrastructure/server/httpEndpoints.ts and the
 * httpRoute*.ts routers. Fields that the server may omit are optional here and
 * the UI renders defensively (unknown name → "unknown", missing duration → "—").
 */

export interface OverviewStats {
  waiting: number;
  active: number;
  delayed: number;
  completed: number;
  dlq: number;
  totalPushed: number;
  totalPulled: number;
  totalCompleted: number;
  totalFailed: number;
  uptime: number;
}

export interface Throughput {
  pushPerSec: number;
  pullPerSec: number;
  completePerSec: number;
  failPerSec: number;
}

export interface WorkerInfo {
  id: string;
  name: string;
  queues: string[];
  lastSeen: number;
  activeJobs: number;
  processedJobs: number;
  failedJobs: number;
}

export interface CronInfo {
  name: string;
  queue: string;
  schedule: string | null;
  repeatEvery: number | null;
  nextRun: number;
  executions: number;
}

export interface StorageStatus {
  diskFull?: boolean;
  error?: string | null;
  since?: number | null;
  path?: string;
  [key: string]: unknown;
}

export interface OverviewResponse {
  ok: boolean;
  stats: OverviewStats;
  throughput: Throughput;
  latency: {
    // Keyed by operation: averages as { pushMs, pullMs, ackMs }; percentiles as
    // { push: { p50, p95, p99 }, pull: {...}, ack: {...} } — these are TCP
    // operation-latency distributions, not job wait/processing time.
    averages: Record<string, number>;
    percentiles: Record<string, { p50: number; p95: number; p99: number }>;
  };
  memory: { heapUsed: number; heapTotal: number; rss: number };
  collections: Record<string, number>;
  workers: { total: number; active: number; list: WorkerInfo[]; truncated: boolean };
  crons: { total: number; list: CronInfo[]; truncated: boolean };
  storage: StorageStatus;
  timestamp: number;
}

export interface QueueSummary {
  name: string;
  waiting: number;
  delayed: number;
  active: number;
  dlq: number;
  paused: boolean;
}

export interface QueuesResponse {
  ok: boolean;
  queues: QueueSummary[];
  total: number;
  limit: number;
  offset: number;
  timestamp: number;
}

export interface QueueCounts {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  prioritized: number;
  paused: number;
  [key: string]: number;
}

export interface JobSummary {
  id: string;
  priority: number;
  createdAt: number;
  runAt: number;
  attempts: number;
  progress: number;
}

export interface QueueDetailResponse {
  ok: boolean;
  name: string;
  counts: QueueCounts;
  paused: boolean;
  priorityCounts: Record<string, number>;
  dlqPreview: Array<{ id: string; data: unknown; attempts: number; createdAt: number }>;
  jobs?: {
    waiting: JobSummary[];
    active: JobSummary[];
    delayed: JobSummary[];
    paused: JobSummary[];
  };
  timestamp: number;
}

export type JobState =
  | 'waiting'
  | 'active'
  | 'completed'
  | 'failed'
  | 'delayed'
  | 'paused'
  | 'prioritized'
  | 'waiting-children'
  | string;

/** A job as returned by GET /queues/:q/jobs/list and GET /jobs/:id. */
export interface Job {
  id: string;
  name?: string;
  queue?: string;
  state?: JobState;
  status?: JobState;
  priority?: number;
  data?: unknown;
  result?: unknown;
  attempts?: number;
  maxAttempts?: number;
  progress?: number;
  createdAt?: number;
  runAt?: number;
  processedOn?: number;
  finishedOn?: number;
  failedReason?: string;
  stacktrace?: string[];
  [key: string]: unknown;
}

export interface DlqEntry {
  id: string;
  jobId?: string;
  queue?: string;
  name?: string;
  reason?: string;
  error?: string;
  data?: unknown;
  attempts?: number;
  enteredAt?: number;
  failedAt?: number;
  [key: string]: unknown;
}

export interface DlqStats {
  ok?: boolean;
  total?: number;
  byReason?: Record<string, number>;
  [key: string]: unknown;
}

export interface StatsResponse {
  ok: boolean;
  stats: OverviewStats & {
    pushPerSec: number;
    pullPerSec: number;
    completePerSec: number;
    failPerSec: number;
    [key: string]: number;
  };
  memory: {
    heapUsed: number;
    heapTotal: number;
    rss: number;
    external: number;
    arrayBuffers: number;
  };
  collections: Record<string, number>;
}

/** A normalized live activity event (from SSE /events). */
export interface ActivityEvent {
  seq: number;
  event: string;
  queue?: string;
  jobId?: string;
  name?: string;
  status: JobState;
  timestamp: number;
  error?: string;
  progress?: number;
}
