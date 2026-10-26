import { afterEach, expect, test } from 'bun:test';
import {
  captureConnectionProfileTarget,
  useConnectionStore,
} from '../src/components/dashboard/stores/connectionStore';
import { queryFromSearch } from '../src/features/discovery/savedViews';
import { scanJobs } from '../src/features/discovery/scanner';
import { createServerTargetClient } from '../src/lib/bq/targetClient';
import { captureServerRequestTarget, serverHeadersFor } from '../src/lib/bq/transport';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const source = () => captureConnectionProfileTarget(useConnectionStore.getState().activeProfileId)!;
function page(offset: number, total: number, count = Math.min(100, total - offset)) {
  return {
    ok: true,
    queues: Array.from({ length: count }, (_, i) => ({
      name: `queue-${offset + i}`,
      waiting: 0,
      delayed: 0,
      active: 0,
      dlq: 0,
      paused: false,
    })),
    total,
    limit: 100,
    offset,
    timestamp: 1,
  };
}

test('walks native queue pagination to reach a selected queue after the first page', async () => {
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname.endsWith('/dashboard/queues'))
      return Response.json(page(Number(url.searchParams.get('offset')), 101));
    expect(url.pathname.endsWith('/queues/queue-100/jobs/list')).toBe(true);
    return Response.json({ ok: true, jobs: [{ id: 'last', state: 'waiting' }] });
  }) as typeof fetch;
  const report = await scanJobs([source()], { queue: 'queue-100' }, new AbortController().signal);
  expect(report.rows[0].job.id).toBe('last');
  expect(report.coverage[0].discoveredQueues).toBe(101);
  expect(report.requests).toBe(3);
  expect(report.partial).toBe(false);
});

test('shares the queue cap across every source', async () => {
  globalThis.fetch = (async (input) =>
    String(input).includes('/dashboard/queues')
      ? Response.json(page(0, 3))
      : Response.json({ ok: true, jobs: [] })) as typeof fetch;
  const report = await scanJobs([source()], {}, new AbortController().signal, { queues: 2 });
  expect(report.scannedQueues).toBe(2);
  expect(report.limitsHit).toContain('queues');
  expect(report.partial).toBe(true);
});

test('timeout and caller cancellation interrupt a pending read with explicit partial coverage', async () => {
  globalThis.fetch = (async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    })) as typeof fetch;
  const timed = await scanJobs([source()], {}, new AbortController().signal, { milliseconds: 5 });
  expect(timed.limitsHit).toContain('milliseconds');
  expect(timed.partial).toBe(true);
  const controller = new AbortController();
  const pending = scanJobs([source()], {}, controller.signal);
  controller.abort();
  expect((await pending).cancelled).toBe(true);
});

test('failure scans include DLQ-only evidence and merge duplicate identity observations', async () => {
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.includes('/dashboard/queues')) return Response.json(page(0, 1));
    if (url.includes('/dlq?'))
      return Response.json({
        ok: true,
        entries: [
          { job: { id: 'both' }, enteredAt: 10, reason: 'max attempts', error: 'HTTP 500' },
          { job: { id: 'dlq-only' }, enteredAt: 20, reason: 'expired', error: 'HTTP 404' },
        ],
        total: 2,
      });
    return Response.json({
      ok: true,
      jobs: [{ id: 'both', state: 'failed', failedReason: 'HTTP 500' }],
    });
  }) as typeof fetch;
  const report = await scanJobs(
    [source()],
    { state: 'failed', includeDlq: true },
    new AbortController().signal
  );
  expect(report.rows.map((row) => row.job.id)).toEqual(['both', 'dlq-only']);
  expect(report.rows[0].dlq?.enteredAt).toBe(10);
  expect(report.inspectedJobs).toBe(3);
});

test('missing requested profiles are reported as skipped instead of complete empty coverage', async () => {
  const report = await scanJobs(
    [source()],
    { profiles: ['missing'] },
    new AbortController().signal
  );
  expect(report.coverage.map((item) => [item.profileId, item.status])).toEqual([
    ['missing', 'skipped'],
  ]);
  expect(report.partial).toBe(true);
});

test('URL time values outside the Date range cannot crash filter rendering', () => {
  expect(queryFromSearch('createdAfter=1e99&createdBefore=-1e99')).toEqual({});
});

test('target factory keeps credentials private and refuses forged request targets', () => {
  const captured = source();
  const target = captureServerRequestTarget(captured);
  expect(Object.keys(target)).toEqual(['baseUrl']);
  expect(serverHeadersFor(target).Authorization).toBe(
    captured.token ? `Bearer ${captured.token}` : undefined
  );
  expect(() => createServerTargetClient({ baseUrl: target.baseUrl })).toThrow(
    'Invalid server request target'
  );
});

test('queue reader rejects short pages, overlaps, wrong offsets and excessive request spans', async () => {
  const client = createServerTargetClient(captureServerRequestTarget(source()));
  for (const value of [
    page(0, 2, 1),
    { ...page(0, 1), offset: 1 },
    { ...page(0, 2), queues: [page(0, 1).queues[0], page(0, 1).queues[0]] },
  ]) {
    globalThis.fetch = (async () => Response.json(value)) as typeof fetch;
    await expect(client.queuesPage()).rejects.toThrow('Malformed queue page');
  }
  await expect(client.queuesPage(501)).rejects.toThrow('Invalid queue pagination');
});
