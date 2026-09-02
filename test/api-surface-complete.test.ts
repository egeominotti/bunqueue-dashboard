import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { api } from '../src/lib/api';

interface CapturedRequest {
  path: string;
  method: string;
  body: unknown;
  authorization: string | null;
  contentType: string | null;
}

const originalFetch = globalThis.fetch;
let requests: CapturedRequest[] = [];

beforeEach(() => {
  requests = [];
  useConnectionStore.setState({
    baseUrl: 'http://classic-api.test',
    token: 'server-secret',
    agentToken: '',
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    requests.push({
      path: `${url.pathname}${url.search}`,
      method: request.method,
      body: request.body ? await request.json() : undefined,
      authorization: request.headers.get('authorization'),
      contentType: request.headers.get('content-type'),
    });
    return new Response(null, { status: 204 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  useConnectionStore.setState({ baseUrl: '/api', token: '', agentToken: '' });
});

describe('classic API complete request surface', () => {
  test('maps every read and diagnostic function to its Bunqueue endpoint', async () => {
    await api.overview();
    await api.queues(10, 20);
    await api.queueDetail('orders', false);
    await api.stats();
    await api.storage();
    await api.health();
    await api.healthz();
    await api.live();
    await api.ready();
    await api.metrics();
    await api.jobsList('orders', { states: ['waiting', 'active'], limit: 5, offset: 10 });
    await api.job('job-1');
    await api.dlq('orders', 7, 14);
    await api.dlqStats('orders');
    await api.crons();
    await api.workers();

    expect(requests.map((request) => request.path)).toEqual([
      '/dashboard',
      '/dashboard/queues?limit=10&offset=20',
      '/dashboard/queues/orders?includeJobs=false',
      '/stats',
      '/storage',
      '/health',
      '/healthz',
      '/live',
      '/ready',
      '/metrics',
      '/queues/orders/jobs/list?states=waiting%2Cactive&limit=5&offset=10',
      '/jobs/job-1',
      '/queues/orders/dlq?limit=7&offset=14',
      '/queues/orders/dlq/stats',
      '/crons',
      '/workers',
    ]);
    expect(requests.every((request) => request.method === 'GET')).toBe(true);
    expect(requests.every((request) => request.contentType === null)).toBe(true);
    expect(requests.every((request) => request.authorization === 'Bearer server-secret')).toBe(
      true
    );
  });

  test('maps every job, queue, limit, DLQ and cron mutation with its exact body', async () => {
    await api.cancelJob('job-1');
    await api.promoteJob('job-1');
    await api.retryJob('job-1');
    await api.pause('orders');
    await api.resume('orders');
    await api.drain('orders');
    await api.obliterate('orders');
    await api.clean('orders', 500, 25);
    await api.setRateLimit('orders', 12);
    await api.clearRateLimit('orders');
    await api.setConcurrency('orders', 4);
    await api.clearConcurrency('orders');
    await api.purgeDlq('orders');
    await api.deleteCron('nightly');

    expect(requests.map(({ path, method, body }) => ({ path, method, body }))).toEqual([
      { path: '/jobs/job-1', method: 'DELETE', body: undefined },
      { path: '/jobs/job-1/promote', method: 'POST', body: undefined },
      { path: '/jobs/job-1/move-to-wait', method: 'POST', body: undefined },
      { path: '/queues/orders/pause', method: 'POST', body: undefined },
      { path: '/queues/orders/resume', method: 'POST', body: undefined },
      { path: '/queues/orders/drain', method: 'POST', body: undefined },
      { path: '/queues/orders/obliterate', method: 'POST', body: undefined },
      { path: '/queues/orders/clean', method: 'POST', body: { grace: 500, limit: 25 } },
      { path: '/queues/orders/rate-limit', method: 'PUT', body: { limit: 12 } },
      { path: '/queues/orders/rate-limit', method: 'DELETE', body: undefined },
      { path: '/queues/orders/concurrency', method: 'PUT', body: { concurrency: 4 } },
      { path: '/queues/orders/concurrency', method: 'DELETE', body: undefined },
      { path: '/queues/orders/dlq/purge', method: 'POST', body: undefined },
      { path: '/crons/nightly', method: 'DELETE', body: undefined },
    ]);
    expect(
      requests
        .filter((request) => request.body !== undefined)
        .every((request) => request.contentType === 'application/json')
    ).toBe(true);
  });

  test('keeps flow-unsafe compatibility mutations fail-closed and builds SSE URLs only', () => {
    expect(() => api.retryCompleted('orders')).toThrow('flow dependency registration');
    expect(() => api.retryDlq('orders')).toThrow('atomic flow-safety precondition');
    expect(api.eventsUrl()).toBe('http://classic-api.test/events');
    expect(api.eventsUrl('orders')).toBe('http://classic-api.test/events/queues/orders');
    expect(requests).toEqual([]);
  });
});
