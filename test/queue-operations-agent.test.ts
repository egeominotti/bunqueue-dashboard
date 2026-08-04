import { describe, expect, test } from 'bun:test';
import type { ServerConfig } from '../agent/manager';
import { routeQueueOperationsRequest } from '../agent/queue/routes';
import { type QueueOperationsClient, QueueOperationsRuntime } from '../agent/queue/runtime';
import type { QueueOperationsPort } from '../agent/queue/types';

const config: ServerConfig = {
  command: 'bunqueue',
  httpPort: 6790,
  tcpPort: 6789,
  dataPath: '/tmp/not-used.db',
  extraEnv: {},
};

function fakeRuntime(calls: string[]): QueueOperationsPort {
  return {
    limits: async (_config, queue, maxJobs) => {
      calls.push(`limits:${queue}:${maxJobs}`);
      return {
        rateLimit: { max: 12, duration: 1000 },
        concurrency: 4,
        rateLimitTtl: 80,
        maxed: false,
      };
    },
    deduplicationJobId: async (_config, queue, id) => {
      calls.push(`dedup:${queue}:${id}`);
      return 'job-7';
    },
    removeDeduplicationKey: async (_config, queue, id) => {
      calls.push(`remove:${queue}:${id}`);
      return 1;
    },
    metrics: async (_config, queue, type, start, end) => {
      calls.push(`metrics:${queue}:${type}:${start}:${end}`);
      return { meta: { count: 7, prevTS: 10, prevCount: 2 }, data: [2, 1], count: 2 };
    },
    trimEvents: async (_config, queue, maxLength) => {
      calls.push(`trim:${queue}:${maxLength}`);
      return 3;
    },
    close: async () => undefined,
  };
}

describe('Queue operations agent contract', () => {
  test('routes all eight Bunqueue Queue methods through exact bounded contracts', async () => {
    const calls: string[] = [];
    const runtime = fakeRuntime(calls);
    const limits = await routeQueueOperationsRequest(
      new Request('http://agent/queue-operations/orders/limits?target=%2Fapi&maxJobs=3'),
      '/queue-operations/orders/limits',
      'GET',
      config,
      runtime,
      true
    );
    expect(limits?.body).toEqual({
      ok: true,
      limits: {
        rateLimit: { max: 12, duration: 1000 },
        concurrency: 4,
        rateLimitTtl: 80,
        maxed: false,
      },
    });
    await routeQueueOperationsRequest(
      new Request(
        'http://agent/queue-operations/orders/deduplication?target=%2Fapi&deduplicationId=invoice%3A7'
      ),
      '/queue-operations/orders/deduplication',
      'GET',
      config,
      runtime,
      true
    );
    await routeQueueOperationsRequest(
      post('/queue-operations/orders/deduplication/remove?target=%2Fapi', {
        deduplicationId: 'invoice:7',
      }),
      '/queue-operations/orders/deduplication/remove',
      'POST',
      config,
      runtime,
      true
    );
    await routeQueueOperationsRequest(
      new Request(
        'http://agent/queue-operations/orders/metrics?target=%2Fapi&type=failed&start=2&end=8'
      ),
      '/queue-operations/orders/metrics',
      'GET',
      config,
      runtime,
      true
    );
    await routeQueueOperationsRequest(
      post('/queue-operations/orders/events/trim?target=%2Fapi', { maxLength: 250 }),
      '/queue-operations/orders/events/trim',
      'POST',
      config,
      runtime,
      true
    );
    expect(calls).toEqual([
      'limits:orders:3',
      'dedup:orders:invoice:7',
      'remove:orders:invoice:7',
      'metrics:orders:failed:2:8',
      'trim:orders:250',
    ]);
  });

  test('fails closed before the runtime for target, query, body and stopped-server errors', async () => {
    const calls: string[] = [];
    const runtime = fakeRuntime(calls);
    const attempts = [
      routeQueueOperationsRequest(
        new Request('http://agent/queue-operations/q/limits?target=https%3A%2F%2Fevil.test'),
        '/queue-operations/q/limits',
        'GET',
        config,
        runtime,
        true
      ),
      routeQueueOperationsRequest(
        new Request('http://agent/queue-operations/q/metrics?target=%2Fapi&type=other'),
        '/queue-operations/q/metrics',
        'GET',
        config,
        runtime,
        true
      ),
      routeQueueOperationsRequest(
        post('/queue-operations/q/events/trim?target=%2Fapi', { maxLength: 1_000_001 }),
        '/queue-operations/q/events/trim',
        'POST',
        config,
        runtime,
        true
      ),
      routeQueueOperationsRequest(
        new Request('http://agent/queue-operations/q/limits?target=%2Fapi'),
        '/queue-operations/q/limits',
        'GET',
        config,
        runtime,
        false
      ),
    ];
    const settled = await Promise.allSettled(attempts);
    expect(settled.every((entry) => entry.status === 'rejected')).toBe(true);
    expect(calls).toEqual([]);
  });

  test('serializes concurrent SDK calls and closes each dedicated client', async () => {
    let active = 0;
    let maximum = 0;
    let closed = 0;
    const client = (): QueueOperationsClient => ({
      waitUntilReady: async () => undefined,
      getGlobalRateLimit: async () => null,
      getGlobalConcurrency: async () => null,
      getRateLimitTtl: async () => -2,
      isMaxed: async () => false,
      getDeduplicationJobId: async () => null,
      removeDeduplicationKey: async () => 0,
      getMetrics: async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await Promise.resolve();
        active -= 1;
        return { meta: { count: 0, prevTS: 0, prevCount: 0 }, data: [], count: 0 };
      },
      trimEvents: async () => 0,
      close: () => {
        closed += 1;
      },
    });
    const runtime = new QueueOperationsRuntime(client);
    await Promise.all([
      runtime.metrics(config, 'q', 'completed', 0, -1),
      runtime.metrics(config, 'q', 'failed', 0, -1),
    ]);
    await runtime.close();
    expect(maximum).toBe(1);
    expect(closed).toBe(2);
    await expect(runtime.trimEvents(config, 'q', 0)).rejects.toThrow('closed');
  });
});

function post(path: string, body: unknown): Request {
  return new Request(`http://agent${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
