import { describe, expect, test } from 'bun:test';
import { createDemoQueueOperations } from '../src/lib/demo/queueOperations';

async function requestOperation(operation: string, query: string): Promise<Response> {
  const path = `/queue-operations/image-processing/${operation}`;
  const request = new Request(`http://localhost:6800${path}?target=%2Fapi&${query}`);
  return createDemoQueueOperations()(request, path);
}

describe('demo metric history bounds', () => {
  test.each([
    ['completed', [7, 9, 4, 6, 3], 29, 7],
    ['failed', [0, 1, 0, 0, 1], 2, 0],
  ] as const)(
    'accepts seven-day %s history without inventing missing buckets',
    async (type, data, count, prevCount) => {
      const response = await requestOperation('metrics', `type=${type}&start=0&end=10079`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        ok: true,
        metrics: {
          meta: { count, prevTS: 1_783_035_039_000, prevCount },
          data,
          count: 5,
        },
      });
    }
  );

  test.each(['start=89921&end=100000', 'start=100000&end=100000'])(
    'accepts absolute index 100000 within the inclusive span: %s',
    async (range) => {
      const response = await requestOperation('metrics', `type=completed&${range}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        ok: true,
        metrics: {
          meta: { count: 29, prevTS: 1_783_035_039_000, prevCount: 7 },
          data: [],
          count: 5,
        },
      });
    }
  );

  test.each([
    'start=100001&end=-1',
    'start=100000&end=100001',
    'start=0&end=10080',
    'start=2&end=1',
  ])('rejects an invalid metric range: %s', async (range) => {
    const response = await requestOperation('metrics', `type=completed&${range}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: expect.any(String) });
  });

  test('accepts exactly 10080 inclusive buckets from a nonzero start', async () => {
    const response = await requestOperation('metrics', 'type=completed&start=1&end=10080');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      metrics: {
        meta: { count: 29, prevTS: 1_783_035_039_000, prevCount: 7 },
        data: [9, 4, 6, 3],
        count: 5,
      },
    });
  });

  test.each(['start=2', 'start=2&end=-1'])(
    'preserves the legacy unbounded-end slice: %s',
    async (range) => {
      const response = await requestOperation('metrics', `type=completed&${range}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        ok: true,
        metrics: {
          meta: { count: 29, prevTS: 1_783_035_039_000, prevCount: 7 },
          data: [4, 6, 3],
          count: 5,
        },
      });
    }
  );

  test('keeps end=-1 valid at the maximum absolute start', async () => {
    const response = await requestOperation('metrics', 'type=completed&start=100000&end=-1');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      metrics: {
        meta: { count: 29, prevTS: 1_783_035_039_000, prevCount: 7 },
        data: [],
        count: 5,
      },
    });
  });
});

describe('demo group bounds remain independent of metric history', () => {
  test.each(['start=0&end=99', 'start=999901&end=1000000'])(
    'accepts 100 inclusive jobs within the existing absolute bound: %s',
    async (range) => {
      const response = await requestOperation('groups', `groupId=tenant-a&${range}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        ok: true,
        group: {
          jobs: 0,
          active: 0,
          totalGrouped: 0,
          paused: false,
          entries: [],
          priorityCounts: {},
          rateLimit: null,
          rateLimitTtl: -2,
          concurrency: null,
        },
      });
    }
  );

  test.each(['start=0&end=100', 'start=1000001', 'start=1000000&end=1000001'])(
    'rejects a group range exceeding the existing bounds: %s',
    async (range) => {
      const response = await requestOperation('groups', `groupId=tenant-a&${range}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ ok: false, error: expect.any(String) });
    }
  );
});
