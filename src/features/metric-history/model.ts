import type { QueueMetricsSnapshot } from '@/features/queue-operations/application/QueueOperationsRepository';

export type MetricType = 'completed' | 'failed';
export type HistoryWindow = '1h' | '24h' | '7d';
export const METRIC_TYPES: readonly MetricType[] = ['completed', 'failed'];
export const HISTORY_WINDOWS: readonly HistoryWindow[] = ['1h', '24h', '7d'];
const MINUTE = 60_000;

export interface HistoryRead {
  completed?: QueueMetricsSnapshot;
  failed?: QueueMetricsSnapshot;
  errors: Partial<Record<MetricType, string>>;
}

export interface MetricCell {
  timestamp: number;
  completed: number | null;
  failed: number | null;
}

export interface MetricCoverage {
  status: 'available' | 'empty' | 'unretained' | 'outside-window' | 'unavailable';
  total: number | null;
  knownMinutes: number;
  availableBuckets: number;
  returnedBuckets: number;
  lifetimeTotal: number | null;
  latestEvent: number | null;
  from: number | null;
  to: number | null;
  error?: string;
}

export interface HistoryView {
  start: number;
  end: number;
  cells: MetricCell[];
  series: Record<MetricType, MetricCoverage>;
}

export function windowMinutes(window: HistoryWindow): number {
  return { '1h': 60, '24h': 1440, '7d': 10080 }[window];
}

/** Native buckets are newest-first; each metric owns its own event anchor. */
export function metricBuckets(snapshot: QueueMetricsSnapshot) {
  const anchor = Math.floor(snapshot.meta.prevTS / MINUTE) * MINUTE;
  return snapshot.data.map((value, index) => ({ timestamp: anchor - index * MINUTE, value }));
}

/** Null cells are unknown time, including idle tails after the latest event. */
export function metricWindow(read: HistoryRead, window: HistoryWindow, now: number): HistoryView {
  const minutes = windowMinutes(window);
  const end = Math.floor(now / MINUTE) * MINUTE;
  const start = end - (minutes - 1) * MINUTE;
  const cells = Array.from({ length: minutes }, (_, index): MetricCell => ({
    timestamp: start + index * MINUTE,
    completed: null,
    failed: null,
  }));
  const coverage = (type: MetricType): MetricCoverage => {
    const snapshot = read[type];
    const result: MetricCoverage = {
      status: 'unavailable',
      total: null,
      knownMinutes: 0,
      availableBuckets: 0,
      returnedBuckets: 0,
      lifetimeTotal: null,
      latestEvent: null,
      from: null,
      to: null,
      error: read.errors[type],
    };
    if (!snapshot) return result;
    result.total = 0;
    result.availableBuckets = snapshot.count;
    result.returnedBuckets = snapshot.data.length;
    result.lifetimeTotal = snapshot.meta.count;
    result.latestEvent = snapshot.meta.prevTS || null;
    for (const bucket of metricBuckets(snapshot)) {
      if (bucket.timestamp < start || bucket.timestamp > end) continue;
      cells[(bucket.timestamp - start) / MINUTE][type] = bucket.value;
      result.total += bucket.value;
      result.knownMinutes += 1;
      result.from =
        result.from === null ? bucket.timestamp : Math.min(result.from, bucket.timestamp);
      result.to = result.to === null ? bucket.timestamp : Math.max(result.to, bucket.timestamp);
    }
    result.status = result.knownMinutes
      ? 'available'
      : snapshot.data.length
        ? 'outside-window'
        : snapshot.meta.count
          ? 'unretained'
          : 'empty';
    return result;
  };
  return {
    start,
    end,
    cells,
    series: { completed: coverage('completed'), failed: coverage('failed') },
  };
}
