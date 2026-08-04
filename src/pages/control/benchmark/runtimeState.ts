import { clampInt, LIMITS, type Phase, percentile, type RunConfig, type Summary } from './engine';

export interface Live {
  pushed: number;
  completed: number;
  pushFailed: number;
  ackFailed: number;
  bytes: number;
  elapsedMs: number;
  pushPerSec: number;
  donePerSec: number;
  activeWorkers: number;
  pushSeries: number[];
  doneSeries: number[];
  etaMs: number | null;
  error: string | null;
}

export const EMPTY_LIVE: Live = {
  pushed: 0,
  completed: 0,
  pushFailed: 0,
  ackFailed: 0,
  bytes: 0,
  elapsedMs: 0,
  pushPerSec: 0,
  donePerSec: 0,
  activeWorkers: 0,
  pushSeries: [],
  doneSeries: [],
  etaMs: null,
  error: null,
};

export interface BenchmarkStats {
  pushed: number;
  completed: number;
  pushFailed: number;
  ackFailed: number;
  bytes: number;
  assigned: number;
  startedAt: number;
  pushLat: number[];
  activeWorkers: number;
  error: string | null;
  lastAt: number;
  lastPushed: number;
  lastDone: number;
  pushSeries: number[];
  doneSeries: number[];
}

export const freshBenchmarkStats = (): BenchmarkStats => ({
  pushed: 0,
  completed: 0,
  pushFailed: 0,
  ackFailed: 0,
  bytes: 0,
  assigned: 0,
  startedAt: 0,
  pushLat: [],
  activeWorkers: 0,
  error: null,
  lastAt: 0,
  lastPushed: 0,
  lastDone: 0,
  pushSeries: [],
  doneSeries: [],
});

export function sampleLive(
  stats: BenchmarkStats,
  config: RunConfig | null,
  phase: Phase,
  now: number
): Live {
  const elapsedMs = now - stats.startedAt;
  const elapsedSeconds = (now - stats.lastAt) / 1000;
  const pushPerSec =
    elapsedSeconds > 0 ? Math.max(0, (stats.pushed - stats.lastPushed) / elapsedSeconds) : 0;
  const donePerSec =
    elapsedSeconds > 0 ? Math.max(0, (stats.completed - stats.lastDone) / elapsedSeconds) : 0;
  stats.lastAt = now;
  stats.lastPushed = stats.pushed;
  stats.lastDone = stats.completed;
  stats.pushSeries = [...stats.pushSeries, pushPerSec].slice(-60);
  stats.doneSeries = [...stats.doneSeries, donePerSec].slice(-60);

  let etaMs: number | null = null;
  if (config?.mode === 'count') {
    const total = clampInt(config.total, 1, LIMITS.total);
    if (phase === 'draining') {
      const recent = stats.doneSeries.slice(-10);
      let rate = recent.length ? recent.reduce((sum, value) => sum + value, 0) / recent.length : 0;
      if (rate <= 0 && elapsedMs > 0) rate = stats.completed / (elapsedMs / 1000);
      if (rate > 0) etaMs = (Math.max(0, total - stats.completed) / rate) * 1000;
    } else if (pushPerSec > 0) {
      etaMs = (Math.max(0, total - stats.pushed) / pushPerSec) * 1000;
    }
  } else if (config?.mode === 'duration') {
    etaMs = Math.max(0, clampInt(config.durationS, 1, LIMITS.durationS) * 1000 - elapsedMs);
  }

  return {
    pushed: stats.pushed,
    completed: stats.completed,
    pushFailed: stats.pushFailed,
    ackFailed: stats.ackFailed,
    bytes: stats.bytes,
    elapsedMs,
    pushPerSec,
    donePerSec,
    activeWorkers: stats.activeWorkers,
    pushSeries: stats.pushSeries,
    doneSeries: stats.doneSeries,
    etaMs,
    error: stats.error,
  };
}

export function summarizeRun(stats: BenchmarkStats, durationMs: number): Summary {
  const seconds = durationMs / 1000 || 1;
  const sorted = [...stats.pushLat].sort((left, right) => left - right);
  return {
    pushed: stats.pushed,
    completed: stats.completed,
    pushFailed: stats.pushFailed,
    ackFailed: stats.ackFailed,
    bytes: stats.bytes,
    durationMs,
    pushPerSec: stats.pushed / seconds,
    donePerSec: stats.completed / seconds,
    mbPerSec: stats.bytes / seconds,
    avg: sorted.length ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length : 0,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.length ? sorted[sorted.length - 1] : 0,
    error: stats.error,
  };
}
