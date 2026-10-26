import { describe, expect, test } from 'bun:test';
import { metricBuckets, metricWindow, windowMinutes } from '../src/features/metric-history/model';
import type { QueueMetricsSnapshot } from '../src/features/queue-operations/application/QueueOperationsRepository';

const minute = 60_000;
const now = Date.UTC(2026, 9, 26, 12, 0, 42);
const anchor = Date.UTC(2026, 9, 26, 12, 0);
const snapshot = (prevTS: number, data: number[], count = 999): QueueMetricsSnapshot => ({
  meta: { count, prevTS, prevCount: data[0] ?? 0 },
  data,
  count: data.length,
});

describe('native history chronology', () => {
  test('rounds each metric anchor to a minute and retains native newest-first order', () => {
    expect(metricBuckets(snapshot(now, [7, 0, 3]))).toEqual([
      { timestamp: anchor, value: 7 },
      { timestamp: anchor - minute, value: 0 },
      { timestamp: anchor - 2 * minute, value: 3 },
    ]);
  });

  test('aligns independently anchored types and preserves unknown cells', () => {
    const result = metricWindow(
      {
        completed: snapshot(now, [7, 0, 3]),
        failed: snapshot(anchor - minute + 3000, [2, 1]),
        errors: {},
      },
      '1h',
      now
    );
    expect(result.cells).toHaveLength(60);
    expect(result.cells.slice(-4)).toEqual([
      { timestamp: anchor - 3 * minute, completed: null, failed: null },
      { timestamp: anchor - 2 * minute, completed: 3, failed: 1 },
      { timestamp: anchor - minute, completed: 0, failed: 2 },
      { timestamp: anchor, completed: 7, failed: null },
    ]);
    expect(result.series.completed).toMatchObject({
      total: 10,
      knownMinutes: 3,
      lifetimeTotal: 999,
    });
    expect(result.series.failed).toMatchObject({
      total: 3,
      knownMinutes: 2,
      latestEvent: anchor - minute + 3000,
    });
  });

  test('filters wall-clock windows inclusively and never substitutes lifetime counts', () => {
    const data = Array.from({ length: 61 }, () => 2);
    const result = metricWindow({ completed: snapshot(now, data, 123456), errors: {} }, '1h', now);
    expect(result.start).toBe(anchor - 59 * minute);
    expect(result.end).toBe(anchor);
    expect(result.cells[0]).toEqual({
      timestamp: anchor - 59 * minute,
      completed: 2,
      failed: null,
    });
    expect(result.series.completed.total).toBe(120);
    expect(result.series.completed.availableBuckets).toBe(61);
    expect(result.series.failed.total).toBeNull();
    expect(result.series.failed.status).toBe('unavailable');
  });

  test('keeps old idle tails outside the window without appending present-time zeroes', () => {
    const old = anchor - 2 * 24 * 60 * minute;
    const result = metricWindow({ completed: snapshot(old + 500, [8, 4]), errors: {} }, '24h', now);
    expect(result.cells).toHaveLength(1440);
    expect(result.cells.every((cell) => cell.completed === null && cell.failed === null)).toBe(
      true
    );
    expect(result.series.completed).toMatchObject({
      status: 'outside-window',
      total: 0,
      knownMinutes: 0,
      latestEvent: old + 500,
      returnedBuckets: 2,
      availableBuckets: 2,
    });
  });

  test('distinguishes no events, no retained history and read failures', () => {
    const result = metricWindow(
      {
        completed: snapshot(0, [], 0),
        failed: snapshot(now, [], 25),
        errors: {},
      },
      '7d',
      now
    );
    expect(result.cells).toHaveLength(10080);
    expect(result.series.completed).toMatchObject({ status: 'empty', latestEvent: null, total: 0 });
    expect(result.series.failed).toMatchObject({
      status: 'unretained',
      lifetimeTotal: 25,
      total: 0,
    });
    const failed = metricWindow({ errors: { completed: 'Agent stopped' } }, '1h', now);
    expect(failed.series.completed).toMatchObject({
      status: 'unavailable',
      total: null,
      error: 'Agent stopped',
    });
    expect(windowMinutes('1h')).toBe(60);
    expect(windowMinutes('24h')).toBe(1440);
    expect(windowMinutes('7d')).toBe(10080);
  });
});
