import { afterEach, expect, test } from 'bun:test';
import {
  captureConnectionProfileTarget,
  useConnectionStore,
} from '../src/components/dashboard/stores/connectionStore';
import { groupFailures } from '../src/features/discovery/failureGroups';
import { activateResultProfile } from '../src/features/discovery/inspect';
import { matchesJob } from '../src/features/discovery/matching';
import {
  loadSavedViews,
  saveSavedViews,
  queryFromSearch,
  queryToSearch,
} from '../src/features/discovery/savedViews';
import { scanJobs } from '../src/features/discovery/scanner';

const originalFetch = globalThis.fetch;
const originalState = useConnectionStore.getState();
afterEach(() => {
  globalThis.fetch = originalFetch;
  useConnectionStore.setState(originalState);
});
const json = (value: unknown) => Response.json(value);
const queues = (names: string[], total = names.length, offset = 0, limit = 100) => ({
  ok: true,
  queues: names.map((name) => ({ name, waiting: 0, delayed: 0, active: 0, dlq: 0, paused: false })),
  total,
  offset,
  limit,
  timestamp: 1,
});
function targets() {
  const store = useConnectionStore.getState();
  store.saveConnection({ baseUrl: 'http://a.test', token: 'secret-a', agentToken: '' });
  const a = captureConnectionProfileTarget(store.activeProfileId)!;
  const id = store.addProfile({
    baseUrl: 'http://b.test',
    token: 'secret-b',
    agentToken: '',
    name: 'B',
  }).id!;
  return [a, captureConnectionProfileTarget(id)!];
}

test('scans paged profiles with captured credentials without activating either source', async () => {
  const sources = targets();
  const requests: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    requests.push(`${url.host}${url.pathname}${url.search}`);
    expect(new Headers(init?.headers).get('Authorization')).toBe(
      url.host === 'a.test' ? 'Bearer secret-a' : 'Bearer secret-b'
    );
    if (url.pathname === '/dashboard/queues') return json(queues(['orders']));
    const offset = Number(url.searchParams.get('offset'));
    if (!offset)
      return json({
        ok: true,
        jobs: Array.from({ length: 100 }, (_, i) => ({
          id: String(i),
          queue: 'orders',
          customId: i === 3 ? 'needle' : '',
          state: 'waiting',
        })),
      });
    return json({
      ok: true,
      jobs: [{ id: '100', queue: 'orders', data: { correlationId: 'needle' }, state: 'waiting' }],
    });
  }) as typeof fetch;
  const active = useConnectionStore.getState().activeProfileId;
  const report = await scanJobs(sources, { text: 'needle' }, new AbortController().signal);
  expect(report.rows.map((row) => row.job.id)).toEqual(['3', '100', '3', '100']);
  expect(report.inspectedJobs).toBe(202);
  expect(report.requests).toBe(6);
  expect(report.partial).toBe(false);
  expect(useConnectionStore.getState().activeProfileId).toBe(active);
  expect(requests.some((path) => path.endsWith('/jobs'))).toBe(false);
});

test('matches only supported fields and respects numeric and time filters', () => {
  const job = {
    id: 'id',
    customId: 'custom',
    name: 'Email',
    tags: ['urgent'],
    createdAt: 200,
    priority: 4,
    state: 'failed',
    data: { correlationId: 42, secret: 'hidden' },
  };
  for (const text of ['custom', 'EMAIL', 'urgent', '42', 'orders'])
    expect(matchesJob(job, 'orders', { text })).toBe(true);
  expect(matchesJob(job, 'orders', { text: 'hidden' })).toBe(false);
  expect(
    matchesJob(job, 'orders', {
      createdAfter: 200,
      createdBefore: 200,
      minPriority: 4,
      state: 'failed',
    })
  ).toBe(true);
  expect(matchesJob(job, 'orders', { minPriority: 5 })).toBe(false);
  expect(matchesJob(job, 'orders', { createdBefore: 199 })).toBe(false);
  expect(matchesJob({ id: 'unknown' }, 'orders', { minPriority: 1 })).toBe(false);
});

test('continues after profile errors and reports skipped sources at shared request cap', async () => {
  const sources = targets();
  globalThis.fetch = (async (input) =>
    String(input).startsWith('http://a.test')
      ? new Response('', { status: 503 })
      : json(queues([]))) as typeof fetch;
  const report = await scanJobs(sources, {}, new AbortController().signal);
  expect(report.partial).toBe(true);
  expect(report.coverage.map((item) => item.status)).toEqual(['error', 'complete']);
  const capped = await scanJobs(sources, {}, new AbortController().signal, { requests: 1 });
  expect(capped.requests).toBe(1);
  expect(capped.coverage[1].status).toBe('skipped');
  expect(capped.limitsHit).toContain('requests');
});

test('enforces job and display caps and deduplicates profile queue ID', async () => {
  const sources = targets();
  globalThis.fetch = (async (input) =>
    String(input).includes('/dashboard/queues')
      ? json(queues(['orders']))
      : json({
          ok: true,
          jobs: Array.from({ length: 100 }, (_, i) => ({ id: String(i) })),
        })) as typeof fetch;
  const report = await scanJobs(sources, {}, new AbortController().signal, {
    jobs: 120,
    results: 5,
  });
  expect(report.inspectedJobs).toBe(120);
  expect(report.rows.length).toBe(5);
  expect(report.matches).toBe(100);
  expect(report.limitsHit).toContain('jobs');
  expect(report.limitsHit).toContain('results');
});

test('rejects malformed queue metadata instead of calling jobs and honours cancellation', async () => {
  const sources = targets();
  globalThis.fetch = (async () => json({ ok: true, queues: [], total: -1 })) as typeof fetch;
  const report = await scanJobs(sources.slice(0, 1), {}, new AbortController().signal);
  expect(report.coverage[0].status).toBe('error');
  const abort = new AbortController();
  abort.abort();
  expect((await scanJobs(sources, {}, abort.signal)).cancelled).toBe(true);
});

test('inspection refuses profile edits and never activates a different target', () => {
  const [source] = targets();
  useConnectionStore.getState().activateProfile(source.id);
  useConnectionStore.getState().setToken('replacement');
  expect(() => activateResultProfile(source)).toThrow('changed');
});

test('allowlists saved metadata, survives corruption and enforces storage bounds', () => {
  let stored = '';
  const storage = {
    getItem: () => stored,
    setItem: (_key: string, value: string) => {
      stored = value;
    },
  };
  expect(loadSavedViews(storage)).toEqual([]);
  expect(
    saveSavedViews(
      [{ name: 'View', query: { text: 'order', token: 'secret', rows: ['payload'] } }],
      storage
    )
  ).toBe(true);
  expect(stored).not.toContain('secret');
  expect(stored).not.toContain('payload');
  expect(loadSavedViews(storage)).toEqual([{ name: 'View', query: { text: 'order' } }]);
  expect(
    saveSavedViews(
      Array.from({ length: 33 }, () => ({ name: 'x', query: {} })),
      storage
    )
  ).toBe(false);
  expect(saveSavedViews([{ name: 'x', query: { text: 'a'.repeat(40000) } }], storage)).toBe(false);
  expect(
    loadSavedViews({
      getItem: () => {
        throw Error('disabled');
      },
    })
  ).toEqual([]);
  expect(queryFromSearch(queryToSearch({ text: 'abc', profiles: ['a'], minPriority: 3 }))).toEqual({
    text: 'abc',
    profiles: ['a'],
    minPriority: 3,
  });
});

test('groups normalized UUID failures while preserving meaningful numeric error codes', () => {
  const source = targets()[0];
  const rows = [
    'HTTP 404 550e8400-e29b-41d4-a716-446655440000',
    'HTTP   404 650e8400-e29b-41d4-a716-446655440000',
    'HTTP 500',
  ].map((failedReason, i) => ({
    source,
    queue: 'orders',
    state: 'failed',
    job: {
      id: String(i),
      failedReason,
      completedAt: i + 1,
      stacktrace: [' at handler\n at caller'],
    },
  }));
  const groups = groupFailures(rows);
  expect(groups.map((group) => group.count)).toEqual([2, 1]);
  expect(groups[0].lastObservedAt).toBe(2);
  expect(groups[0].exampleIds).toEqual(['0', '1']);
});
