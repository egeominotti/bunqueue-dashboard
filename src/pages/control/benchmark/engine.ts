import type { BulkJobBody } from '@/lib/bq';

// Pure types + helpers for the Benchmark page. No React, so it stays trivially
// testable and keeps the engine/UI focused.

export type RunMode = 'count' | 'duration';
export type Phase = 'idle' | 'running' | 'draining' | 'stopping' | 'done' | 'stopped' | 'error';

export interface RunConfig {
  queue: string;
  mode: RunMode;
  /** count mode: how many jobs to produce. */
  total: number;
  /** duration mode: how long to run producers + workers, seconds. */
  durationS: number;
  /** producer push batch size. */
  batch: number;
  /** parallel producer loops. */
  producers: number;
  /** bytes of dummy payload per job. */
  payload: number;
  /** parallel simulated worker loops (pull → process → ack). */
  workers: number;
  /** jobs each worker reserves per pull. */
  workerBatch: number;
  /** simulated processing time per pulled batch, ms. */
  processMs: number;
  durable: boolean;
  removeOnComplete: boolean;
}

export interface Summary {
  pushed: number;
  completed: number;
  pushFailed: number;
  ackFailed: number;
  bytes: number;
  durationMs: number;
  pushPerSec: number;
  donePerSec: number;
  mbPerSec: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  error: string | null;
}

export interface RunRecord extends Summary {
  id: number;
  at: number;
  mode: RunMode;
  producers: number;
  workers: number;
}

export const LIMITS = {
  total: 1_000_000,
  batch: 5000,
  producers: 64,
  payload: 65_536,
  workers: 64,
  workerBatch: 1000,
  processMs: 60_000,
  durationS: 600,
};

export const DEFAULT_CONFIG: RunConfig = {
  queue: 'benchmark',
  mode: 'count',
  total: 5000,
  durationS: 30,
  batch: 100,
  producers: 4,
  payload: 128,
  workers: 4,
  workerBatch: 100,
  processMs: 5,
  durable: false,
  removeOnComplete: true,
};

export const BENCHMARK_QUEUE_PREFIX = 'bq-dashboard-benchmark-';

export function createBenchmarkQueueName(): string {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new Error('A cryptographically secure browser is required to create a benchmark queue.');
  }
  return `${BENCHMARK_QUEUE_PREFIX}${globalThis.crypto.randomUUID()}`;
}

export function isDashboardBenchmarkQueue(queue: string): boolean {
  return new RegExp(
    `^${BENCHMARK_QUEUE_PREFIX}[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
    'i'
  ).test(queue);
}

export const PRESETS: Record<string, Partial<RunConfig>> = {
  Smoke: {
    mode: 'count',
    total: 200,
    batch: 50,
    producers: 2,
    workers: 1,
    workerBatch: 50,
    processMs: 0,
  },
  Standard: {
    mode: 'count',
    total: 5000,
    batch: 100,
    producers: 4,
    workers: 4,
    workerBatch: 100,
    processMs: 5,
  },
  Stress: {
    mode: 'count',
    total: 50_000,
    batch: 500,
    producers: 16,
    workers: 16,
    workerBatch: 200,
    processMs: 0,
  },
  Soak: {
    mode: 'duration',
    durationS: 30,
    batch: 100,
    producers: 4,
    workers: 8,
    workerBatch: 100,
    processMs: 10,
  },
};

export const clampInt = (v: number, lo: number, hi: number): number =>
  Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.floor(v))) : lo;

export function benchmarkQueueError(queue: string): string | null {
  if (!queue) return 'Queue name is required.';
  if (queue.length > 256) return 'Queue name is too long (maximum 256 characters).';
  if (!/^[a-zA-Z0-9_\-.:]+$/.test(queue)) return 'Queue name contains unsupported characters.';
  return null;
}

/** Nearest-rank percentile over an already-sorted ascending array. */
export const percentile = (sorted: number[], p: number): number =>
  sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]
    : 0;

export const makeJobs = (
  base: number,
  size: number,
  blob: string,
  durable: boolean,
  removeOnComplete: boolean,
  runId?: string,
  stallTimeout?: number
): BulkJobBody[] =>
  Array.from({ length: size }, (_, i) => ({
    data: { i: base + i, blob },
    durable,
    removeOnComplete,
    ...(stallTimeout === undefined ? {} : { stallTimeout }),
    ...(runId
      ? {
          jobId: `${runId}-${base + i}`,
          tags: ['bunqueue-dashboard-benchmark', runId],
        }
      : {}),
  }));

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sleep up to `ms`, waking every ≤100ms to re-check `keepWaiting` — so a long
 * simulated processing delay can be cut short the moment the user hits Stop.
 */
export const sleepWhile = async (ms: number, keepWaiting: () => boolean): Promise<void> => {
  const end = performance.now() + ms;
  while (keepWaiting() && performance.now() < end) {
    await sleep(Math.min(100, Math.max(0, end - performance.now())));
  }
};

export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const fmtRate = (v: number): string => {
  if (v >= 1_000_000) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}K`;
  return `${Math.round(v)}`;
};
