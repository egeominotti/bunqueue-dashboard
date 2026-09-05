import { describe, expect, test } from 'bun:test';
import { API_ROOTS, demoApiResponse } from '../src/lib/demo/api';

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Expected a demo object');
  }
  return value as Record<string, unknown>;
}

describe('demo API dispatcher complete route surface', () => {
  test('recognizes every public API root used by the dashboard', () => {
    const expectedRoots = [
      'events',
      'health',
      'healthz',
      'live',
      'ready',
      'ping',
      'stats',
      'metrics',
      'storage',
      'dashboard',
      'queues',
      'queue-operations',
      'jobs',
      'crons',
      'webhooks',
      'workers',
      'dlq',
      'control',
      'db',
      'workflows',
      'flows',
      'backup',
      'gc',
      'heapstats',
    ];
    expect([...API_ROOTS].sort()).toEqual(expectedRoots.sort());
  });

  test('dispatches control, workflow, backup and Flow agent routes', () => {
    const logs = demoApiResponse('/control/logs', 'GET', '') as { lines: Array<{ seq: number }> };
    expect(logs.lines).toHaveLength(5);
    expect(logs.lines[0]).toMatchObject({ seq: 1 });
    expect(demoApiResponse('/control/config', 'GET', '')).toMatchObject({
      command: 'bunx bunqueue@2.9.4 start',
      configRevision: 1,
    });
    expect(demoApiResponse('/control/status', 'GET', '')).toMatchObject({
      status: 'running',
      healthy: true,
    });
    expect(demoApiResponse('/workflows/stats', 'GET', '')).toMatchObject({
      ok: true,
      activeTotal: 3,
    });
    expect(demoApiResponse('/backup/status', 'GET', '')).toMatchObject({
      ok: true,
      result: { success: true },
    });
    expect(demoApiResponse('/flows/tree', 'GET', '?depth=0')).toMatchObject({
      ok: true,
      result: { flow: { id: 'flow-order-9a3f', children: [] } },
    });
  });

  test('returns specific mutation receipts before the read dispatcher', () => {
    expect(demoApiResponse('/gc', 'POST', '')).toMatchObject({
      ok: true,
      before: { heapUsed: 118 },
      after: { heapUsed: 94 },
    });
    expect(demoApiResponse('/db/query', 'POST', '')).toMatchObject({
      ok: true,
      columns: ['note'],
      rowCount: 1,
    });
    expect(demoApiResponse('/queues/orders/jobs', 'POST', '')).toMatchObject({
      ok: true,
      ids: ['demo-1'],
    });
    expect(demoApiResponse('/queues/orders/jobs/bulk', 'POST', '')).toMatchObject({
      ok: true,
      ids: ['demo-1'],
    });
    expect(demoApiResponse('/queues/orders/pause', 'POST', '')).toEqual({ ok: true });
  });

  test('serves every top-level diagnostic and paginated dashboard collection', () => {
    expect(demoApiResponse('/workers', 'GET', '')).toMatchObject({
      ok: true,
      data: { stats: { total: 3 } },
    });
    expect(demoApiResponse('/ready', 'GET', '')).toEqual({ ok: true, ready: true });
    expect(demoApiResponse('/metrics', 'GET', '')).toMatchObject({
      ok: true,
      metrics: { totalPushed: expect.any(Number) },
    });
    const heap = demoApiResponse('/heapstats', 'GET', '') as {
      ok: boolean;
      heap: { objectCount: number };
      topObjectTypes: Array<{ type: string; count: number }>;
    };
    expect(heap).toMatchObject({
      ok: true,
      heap: { objectCount: 486_204 },
    });
    expect(heap.topObjectTypes).toHaveLength(5);
    expect(heap.topObjectTypes[0]).toEqual({ type: 'Structure', count: 42_118 });

    const page = demoApiResponse('/dashboard/queues/', 'GET', '?limit=2&offset=1');
    expect(page).toMatchObject({ total: 4, limit: 2, offset: 1 });
    expect((page.queues as unknown[]).length).toBe(2);
    const fallback = demoApiResponse('/dashboard/queues', 'GET', '?limit=-1&offset=nan');
    expect(Number(fallback.limit)).toBeGreaterThan(0);
    expect(Number(fallback.offset)).toBeGreaterThanOrEqual(0);

    for (const path of [
      '/health',
      '/ping',
      '/stats',
      '/storage',
      '/dashboard',
      '/queues/summary',
      '/crons',
      '/webhooks',
      '/dlq/stats',
    ]) {
      const value = demoApiResponse(path, 'GET', '');
      if (Array.isArray(value)) expect(value.length).toBeGreaterThan(0);
      else expect(record(value)).not.toEqual({});
    }
    expect(demoApiResponse('/dashboard/queues/unknown', 'GET', '')).toMatchObject({
      ok: true,
      name: 'emails',
    });
  });

  test('covers queue counts, DLQ/configuration and state-filtered job reads', () => {
    expect(demoApiResponse('/queues/emails/counts', 'GET', '')).toMatchObject({ ok: true });
    expect(demoApiResponse('/queues/unknown/counts', 'GET', '')).toEqual({
      ok: true,
      counts: {},
    });
    expect(demoApiResponse('/queues/emails/dlq/stats', 'GET', '')).toMatchObject({
      stats: { total: 2 },
    });
    expect(demoApiResponse('/queues/other/dlq/stats', 'GET', '')).toMatchObject({
      stats: { total: 0 },
    });
    expect(demoApiResponse('/queues/emails/dlq', 'GET', '')).toMatchObject({ ok: true });
    expect(demoApiResponse('/queues/other/dlq', 'GET', '')).toEqual({
      ok: true,
      entries: [],
      total: 0,
    });
    expect(demoApiResponse('/queues/orders/stall-config', 'GET', '')).toMatchObject({
      config: { enabled: true, maxStalls: 3 },
    });
    expect(demoApiResponse('/queues/orders/dlq-config', 'GET', '')).toMatchObject({
      config: { autoRetry: false, maxEntries: 1000 },
    });

    const waiting = demoApiResponse('/queues/orders/jobs/list', 'GET', '?states=waiting') as {
      jobs: Array<{ state: string; queue: string }>;
    };
    expect(waiting.jobs.length).toBeGreaterThan(0);
    expect(waiting.jobs.every((job) => ['waiting', 'prioritized'].includes(job.state))).toBe(true);
    expect(waiting.jobs.every((job) => job.queue === 'orders')).toBe(true);
  });

  test('covers canonical/custom jobs and every database sub-resource', () => {
    expect(demoApiResponse('/jobs/custom/order%3A7', 'GET', '')).toMatchObject({
      ok: true,
      job: { id: 'demo-custom:order:7' },
    });
    expect(demoApiResponse('/jobs/demo-job/result', 'GET', '')).toEqual({
      ok: true,
      id: 'demo-job',
      result: { sent: true, provider: 'demo' },
    });
    expect(demoApiResponse('/jobs/demo-job/logs', 'GET', '')).toMatchObject({
      ok: true,
      data: { count: 3 },
    });
    expect(demoApiResponse('/jobs/demo-job', 'GET', '')).toMatchObject({
      ok: true,
      job: { id: 'demo-job' },
    });
    expect(demoApiResponse('/db/info', 'GET', '')).toMatchObject({ ok: true });
    const tables = demoApiResponse('/db/tables', 'GET', '') as { tables: unknown[] };
    expect(Array.isArray(tables.tables)).toBe(true);
    expect(tables.tables).toHaveLength(6);
    expect(demoApiResponse('/db/tables/queues/schema', 'GET', '')).toMatchObject({
      ok: true,
      table: 'queues',
    });
    expect(demoApiResponse('/db/tables/queues/cell', 'GET', '')).toEqual({
      ok: true,
      value: 'demo cell value',
    });
    expect(demoApiResponse('/db/tables/queues', 'GET', '?limit=1')).toMatchObject({
      ok: true,
      total: 4,
    });
    expect(demoApiResponse('/unknown', 'GET', '')).toEqual({ ok: true });
  });
});
