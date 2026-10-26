import { describe, expect, test } from 'bun:test';
import { groupJobsRange, metricsRange } from '../agent/queue/validation';
import { bqQueueOperationsRepository } from '../src/features/queue-operations/infrastructure/bqQueueOperationsRepository';

describe('native metric history bridge bounds', () => {
  test('accepts a seven-day inclusive range ending at index 10079', () => {
    expect(metricsRange(new URLSearchParams('start=0&end=10079'))).toEqual({
      start: 0,
      end: 10079,
    });
  });

  test('bounds absolute indices independently of the inclusive response span', () => {
    expect(metricsRange(new URLSearchParams('start=89921&end=100000'))).toEqual({
      start: 89921,
      end: 100000,
    });
    expect(() => metricsRange(new URLSearchParams('start=0&end=10080'))).toThrow();
    expect(() => metricsRange(new URLSearchParams('start=100001&end=-1'))).toThrow();
    expect(() => metricsRange(new URLSearchParams('start=100000&end=100001'))).toThrow();
    expect(() => metricsRange(new URLSearchParams('start=2&end=1'))).toThrow();
  });

  test('preserves legacy unbounded-end requests and group pagination limits', () => {
    expect(metricsRange(new URLSearchParams('start=15'))).toEqual({ start: 15, end: -1 });
    expect(metricsRange(new URLSearchParams('start=15&end=-1'))).toEqual({ start: 15, end: -1 });
    expect(groupJobsRange(new URLSearchParams('start=999901&end=1000000'))).toEqual({
      start: 999901,
      end: 1000000,
    });
    expect(() => groupJobsRange(new URLSearchParams('start=0&end=100'))).toThrow();
    expect(() => groupJobsRange(new URLSearchParams('start=1000001'))).toThrow();
  });

  test('accepts 10080 parsed buckets and rejects 10081 without relaxing group parsing', async () => {
    const realFetch = globalThis.fetch;
    let length = 10080;
    globalThis.fetch = (async () =>
      Response.json({
        ok: true,
        metrics: {
          meta: { count: 90000, prevTS: 60000, prevCount: 3 },
          data: Array.from({ length }, () => 1),
          count: 20160,
        },
        group: {
          jobs: 101,
          active: 0,
          totalGrouped: 101,
          paused: false,
          entries: Array.from({ length: 101 }, (_, id) => ({
            id: String(id),
            name: 'job',
            priority: 0,
            delay: 0,
            timestamp: 1,
          })),
          priorityCounts: {},
          rateLimit: null,
          rateLimitTtl: -2,
          concurrency: null,
        },
      })) as typeof fetch;
    try {
      expect(
        (await bqQueueOperationsRepository.metrics('orders', 'completed', 0, 10079)).data
      ).toHaveLength(10080);
      length = 10081;
      await expect(
        bqQueueOperationsRepository.metrics('orders', 'completed', 0, 10080)
      ).rejects.toThrow('Malformed Queue metrics response');
      await expect(bqQueueOperationsRepository.group('orders', 'tenant')).rejects.toThrow(
        'Malformed Queue group response'
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
