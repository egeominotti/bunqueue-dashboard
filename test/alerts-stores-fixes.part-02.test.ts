import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { type AlertRule, useAlertsStore } from '../src/components/dashboard/stores/alertsStore';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { useToastStore } from '../src/components/dashboard/stores/toastStore';
import {
  alertConnectionIdentity,
  useAlertEngine,
  useAlertRuntimeStore,
} from '../src/lib/useAlertEngine';
import { renderHook, settle } from './domSetup';

// Regression tests for the audited alert-engine / connection-store defects:
// unknown-is-not-resolved on a partial fetch failure, a cooldown that defers
// instead of dropping, identity reconciliation while the server is down, the
// paginated dlq source, the same-tick toast burst, and trailing-slash trimming.

const rule = (over: Partial<AlertRule>): AlertRule => ({
  id: 'r1',
  name: 'test rule',
  metric: 'waiting',
  operator: '>=',
  threshold: 5,
  queue: '',
  channel: 'email',
  enabled: true,
  ...over,
});

let waiting = 10;
let completed = 90;
let failed = 10;
let failSummary = false;
let failOverview = false;
let queueCount = 1;
let emptyPercentiles = false;
const realFetch = globalThis.fetch;

function route(url: string): Response {
  if (url.includes('/queues/summary')) {
    if (failSummary) return Response.json({ ok: false, error: 'boom' }, { status: 500 });
    return Response.json([
      {
        name: 'q1',
        paused: false,
        counts: {
          waiting,
          prioritized: 0,
          active: 0,
          completed,
          failed,
          delayed: 0,
        },
      },
    ]);
  }
  if (url.includes('/dashboard/queues')) {
    // Paginated exactly like bunqueue: `total` is the full count, the page is a
    // window of it — so an engine that reads only page 1 misses the tail.
    const params = new URL(url, 'http://x').searchParams;
    const limit = Number(params.get('limit') ?? 500);
    const offset = Number(params.get('offset') ?? 0);
    const all = Array.from({ length: queueCount }, (_, i) => ({ name: `q${i + 1}`, dlq: 7 }));
    return Response.json({
      ok: true,
      queues: all.slice(offset, offset + limit),
      total: all.length,
      limit,
      offset,
    });
  }
  if (url.endsWith('/dashboard')) {
    if (failOverview) return Response.json({ ok: false, error: 'down' }, { status: 500 });
    return Response.json({
      ok: true,
      latency: { percentiles: emptyPercentiles ? {} : { push: { p99: 120 } } },
    });
  }
  return Response.json({ ok: true });
}

beforeEach(() => {
  waiting = 10;
  completed = 90;
  failed = 10;
  failSummary = false;
  failOverview = false;
  queueCount = 1;
  emptyPercentiles = false;
  globalThis.fetch = ((input: RequestInfo | URL) =>
    Promise.resolve(route(String(input)))) as typeof fetch;
  useAlertsStore.setState({ rules: [] });
  useAlertRuntimeStore.setState({
    breaching: [],
    status: 'idle',
    error: null,
    connectionIdentity: null,
  });
  useToastStore.setState({ toasts: [] });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  useAlertsStore.setState({ rules: [] });
  useConnectionStore.setState({ baseUrl: '/api', token: '' });
});

const toasts = () => useToastStore.getState().toasts;
const breaching = () => useAlertRuntimeStore.getState().breaching;

// A never-breaching filler rule whose id changes the enabled-rule signature,
// which re-arms the effect and runs an immediate extra tick — the test-side
// substitute for waiting out POLL_MS.
const filler = (n: number): AlertRule =>
  rule({ id: `pad${n}`, name: `pad${n}`, metric: 'dlq', operator: '>', threshold: 1e9 });

async function retick(n: number, rules: AlertRule[]): Promise<void> {
  act(() => {
    useAlertsStore.setState({ rules: [...rules, filler(n)] });
  });
  await settle(10);
}

describe('alert engine — audited fixes', () => {
  test('retargeting between queue pages never mixes URL/bearer targets or publishes stale facts', async () => {
    useConnectionStore.setState({ baseUrl: 'http://server-a', token: 'token-a' });
    useAlertsStore.setState({
      rules: [rule({ metric: 'dlq', queue: 'q600', threshold: 5 })],
    });

    const requests: Array<{ url: string; authorization: string | null }> = [];
    let switched = false;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const parsedUrl = new URL(url);
      const authorization = new Headers(init?.headers).get('Authorization');
      requests.push({ url, authorization });

      let response: Response;
      if (parsedUrl.pathname.endsWith('/queues/summary')) {
        response = Response.json([
          {
            name: 'q600',
            paused: false,
            counts: {
              waiting: 0,
              prioritized: 0,
              active: 0,
              completed: 0,
              failed: 0,
              delayed: 0,
            },
          },
        ]);
      } else if (parsedUrl.pathname.endsWith('/dashboard/queues')) {
        const limit = Number(parsedUrl.searchParams.get('limit'));
        const offset = Number(parsedUrl.searchParams.get('offset'));
        if (parsedUrl.origin === 'http://server-a') {
          const queues = Array.from({ length: Math.min(500, 600 - offset) }, (_, index) => ({
            name: `q${offset + index + 1}`,
            dlq: offset + index === 599 ? 7 : 0,
          }));
          response = Response.json({ ok: true, queues, total: 600, limit, offset });
        } else if (offset === 0) {
          // Server B's complete snapshot is explicitly within threshold.
          response = Response.json({
            ok: true,
            queues: [{ name: 'q600', dlq: 0 }],
            total: 1,
            limit,
            offset,
          });
        } else {
          // A stale global-client walk would request this continuation from B.
          // Keep it structurally compatible with A so mixed data could appear
          // trustworthy; the pinned/lifecycle implementation must never ask.
          const queues = Array.from({ length: 100 }, (_, index) => ({
            name: `q${offset + index + 1}`,
            dlq: index === 99 ? 7 : 0,
          }));
          response = Response.json({ ok: true, queues, total: 600, limit, offset });
        }
      } else if (parsedUrl.pathname.endsWith('/dashboard')) {
        response = Response.json({
          ok: true,
          latency: { percentiles: { push: { p99: 1 } } },
        });
      } else {
        response = Response.json({ error: 'unexpected request' }, { status: 500 });
      }

      if (
        !switched &&
        parsedUrl.origin === 'http://server-a' &&
        parsedUrl.pathname.endsWith('/dashboard/queues') &&
        parsedUrl.searchParams.get('offset') === '0'
      ) {
        switched = true;
        // Resolve page A/0 only after Settings selects B. A client that reads
        // Settings per page will continue this same walk at B/500 with token B.
        return Promise.resolve(response).then((value) => {
          act(() => {
            useConnectionStore.setState({ baseUrl: 'http://server-b', token: 'token-b' });
          });
          return value;
        });
      }
      return Promise.resolve(response);
    }) as typeof fetch;

    const h = renderHook(() => useAlertEngine());
    await settle(50);

    expect(switched).toBe(true);
    expect(
      requests.some(({ url }) => {
        const parsedUrl = new URL(url);
        return (
          parsedUrl.origin === 'http://server-b' &&
          parsedUrl.pathname.endsWith('/dashboard/queues') &&
          parsedUrl.searchParams.get('offset') === '500'
        );
      })
    ).toBe(false);
    expect(
      requests
        .filter(({ url }) => url.startsWith('http://server-a/'))
        .every(({ authorization }) => authorization === 'Bearer token-a')
    ).toBe(true);
    expect(
      requests
        .filter(({ url }) => url.startsWith('http://server-b/'))
        .every(({ authorization }) => authorization === 'Bearer token-b')
    ).toBe(true);
    expect(useAlertRuntimeStore.getState()).toMatchObject({
      breaching: [],
      status: 'live',
      error: null,
      connectionIdentity: alertConnectionIdentity('http://server-b', 'token-b'),
    });
    expect(toasts()).toEqual([]);
    h.unmount();
  });

  test('a source failure keeps the known breach published (unknown ≠ all clear)', async () => {
    const rules = [rule({ metric: 'waiting', threshold: 5 })];
    useAlertsStore.setState({ rules });
    const h = renderHook(() => useAlertEngine());
    await settle(10);
    expect(breaching().map((b) => b.ruleId)).toEqual(['r1']);

    // /queues/summary starts failing while the server is otherwise up.
    failSummary = true;
    await retick(1, rules);
    expect(breaching().map((b) => b.ruleId)).toEqual(['r1']);
    expect(breaching()[0]?.value).toBe(10);
    h.unmount();
  });
});
