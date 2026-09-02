import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { bqQueueOperationsRepository } from '../src/features/queue-operations/infrastructure/bqQueueOperationsRepository';

const realFetch = globalThis.fetch;

describe('Queue operations client adapter', () => {
  beforeEach(() => {
    useConnectionStore.setState({ baseUrl: 'http://server.test', token: '', agentToken: '' });
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    useConnectionStore.setState({ baseUrl: '/api', token: '', agentToken: '' });
  });

  test('pins reads and mutations to the selected managed target', async () => {
    const requests: Array<{ path: string; method: string; body: unknown }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      requests.push({
        path: `${url.pathname}${url.search}`,
        method: request.method,
        body: request.method === 'POST' ? await request.json() : undefined,
      });
      if (url.pathname.endsWith('/limits')) {
        return Response.json({
          ok: true,
          limits: {
            rateLimit: { max: 8, duration: 2000 },
            concurrency: 2,
            rateLimitTtl: 40,
            maxed: true,
          },
        });
      }
      if (url.pathname.endsWith('/groups')) {
        return Response.json({
          ok: true,
          group: {
            jobs: 2,
            active: 1,
            totalGrouped: 5,
            paused: false,
            entries: [{ id: 'group-job', name: 'deliver', priority: 2, delay: 0, timestamp: 100 }],
            priorityCounts: { '2': 1 },
            rateLimit: { max: 4, duration: 3000 },
            rateLimitTtl: 20,
            concurrency: 2,
          },
        });
      }
      if (url.pathname.endsWith('/groups/pause') || url.pathname.endsWith('/groups/resume')) {
        return Response.json({ ok: true, changed: true });
      }
      if (url.pathname.includes('/groups/') && !url.pathname.endsWith('/remove')) {
        return Response.json({ ok: true, applied: true });
      }
      if (url.pathname.includes('/groups/') && url.pathname.endsWith('/remove')) {
        return Response.json({ ok: true, removed: 1 });
      }
      if (url.pathname.endsWith('/deduplication')) {
        return Response.json({ ok: true, jobId: 'job-a' });
      }
      if (url.pathname.endsWith('/deduplication/remove')) {
        return Response.json({ ok: true, removed: 1 });
      }
      if (url.pathname.endsWith('/metrics')) {
        return Response.json({
          ok: true,
          metrics: { meta: { count: 3, prevTS: 2, prevCount: 1 }, data: [1], count: 1 },
        });
      }
      return Response.json({ ok: true, removed: 4 });
    }) as typeof fetch;

    expect(await bqQueueOperationsRepository.limits('orders.eu', 2)).toEqual({
      rateLimit: { max: 8, duration: 2000 },
      concurrency: 2,
      rateLimitTtl: 40,
      maxed: true,
    });
    expect(
      await bqQueueOperationsRepository.group('orders.eu', 'tenant / 1', 2, 50, 10, 19)
    ).toMatchObject({
      jobs: 2,
      active: 1,
      totalGrouped: 5,
      paused: false,
      entries: [{ id: 'group-job', priority: 2 }],
      priorityCounts: { '2': 1 },
      concurrency: 2,
    });
    await bqQueueOperationsRepository.setGroupRateLimit('orders.eu', 'tenant / 1', 4, 3000);
    expect(await bqQueueOperationsRepository.removeGroupRateLimit('orders.eu', 'tenant / 1')).toBe(
      1
    );
    await bqQueueOperationsRepository.setGroupConcurrency('orders.eu', 'tenant / 1', 2);
    expect(
      await bqQueueOperationsRepository.removeGroupConcurrency('orders.eu', 'tenant / 1')
    ).toBe(1);
    expect(await bqQueueOperationsRepository.pauseGroup('orders.eu', 'tenant / 1')).toBe(true);
    expect(await bqQueueOperationsRepository.resumeGroup('orders.eu', 'tenant / 1')).toBe(true);
    expect(await bqQueueOperationsRepository.deduplicationJobId('orders.eu', 'key / 1')).toBe(
      'job-a'
    );
    expect(await bqQueueOperationsRepository.removeDeduplicationKey('orders.eu', 'key / 1')).toBe(
      1
    );
    expect(await bqQueueOperationsRepository.metrics('orders.eu', 'failed', 2, 9)).toEqual({
      meta: { count: 3, prevTS: 2, prevCount: 1 },
      data: [1],
      count: 1,
    });
    expect(await bqQueueOperationsRepository.trimEvents('orders.eu', 50)).toBe(4);
    expect(
      requests.every((request) => request.path.includes('target=http%3A%2F%2Fserver.test'))
    ).toBe(true);
    expect(requests[9]).toMatchObject({
      method: 'POST',
      body: { deduplicationId: 'key / 1' },
    });
    expect(requests[11]).toMatchObject({ method: 'POST', body: { maxLength: 50 } });
    expect(requests[1]?.path).toContain('start=10');
    expect(requests[1]?.path).toContain('end=19');
  });

  test('rejects malformed agent payloads instead of rendering guessed state', async () => {
    globalThis.fetch = (async () =>
      Response.json({
        ok: true,
        limits: { rateLimit: null, concurrency: -1, rateLimitTtl: -2, maxed: false },
      })) as typeof fetch;
    await expect(bqQueueOperationsRepository.limits('q')).rejects.toThrow(
      'Malformed Queue limits response'
    );
  });
});
