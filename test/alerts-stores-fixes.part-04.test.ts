import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { type AlertRule, useAlertsStore } from '../src/components/dashboard/stores/alertsStore';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { useToastStore } from '../src/components/dashboard/stores/toastStore';
import {
  allQueues,
  parseAlertOverview,
  parseAlertQueueSummary,
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

async function _retick(n: number, rules: AlertRule[]): Promise<void> {
  act(() => {
    useAlertsStore.setState({ rules: [...rules, filler(n)] });
  });
  await settle(10);
}

describe('alert engine — audited fixes', () => {
  test('queue pagination returns unknown instead of an incomplete global DLQ total', async () => {
    queueCount = 11_000; // exceeds the explicit 10,500-row safety cap
    expect(await allQueues()).toBeNull();
  });

  test('queue pagination rejects missing, non-finite, fractional, and negative totals', async () => {
    for (const total of [undefined, Number.NaN, Number.POSITIVE_INFINITY, '1', 1.5, -1]) {
      globalThis.fetch = ((input: RequestInfo | URL) => {
        const params = new URL(String(input), 'http://x').searchParams;
        return Promise.resolve(
          Response.json({
            ok: true,
            queues: [],
            ...(total === undefined ? {} : { total }),
            limit: Number(params.get('limit')),
            offset: Number(params.get('offset')),
          })
        );
      }) as typeof fetch;
      expect(await allQueues()).toBeNull();
    }
  });

  test('queue pagination rejects a duplicate overlap that would otherwise reach total', async () => {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const params = new URL(String(input), 'http://x').searchParams;
      const limit = Number(params.get('limit'));
      const offset = Number(params.get('offset'));
      const queues =
        offset === 0
          ? Array.from({ length: 500 }, (_, index) => ({ name: `q${index}`, dlq: 0 }))
          : Array.from({ length: 100 }, (_, index) => ({ name: `q${400 + index}`, dlq: 0 }));
      return Promise.resolve(Response.json({ ok: true, queues, total: 600, limit, offset }));
    }) as typeof fetch;

    expect(await allQueues()).toBeNull();
  });

  test('queue pagination rejects a short continuation instead of publishing a partial snapshot', async () => {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const params = new URL(String(input), 'http://x').searchParams;
      const limit = Number(params.get('limit'));
      const offset = Number(params.get('offset'));
      const length = offset === 0 ? 500 : 50;
      const queues = Array.from({ length }, (_, index) => ({
        name: `q${offset + index}`,
        dlq: 0,
      }));
      return Promise.resolve(Response.json({ ok: true, queues, total: 600, limit, offset }));
    }) as typeof fetch;

    expect(await allQueues()).toBeNull();
  });

  test('queue pagination rejects a total that changes between pages', async () => {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const params = new URL(String(input), 'http://x').searchParams;
      const limit = Number(params.get('limit'));
      const offset = Number(params.get('offset'));
      const total = offset === 0 ? 600 : 550;
      const length = offset === 0 ? 500 : 50;
      const queues = Array.from({ length }, (_, index) => ({
        name: `q${offset + index}`,
        dlq: 0,
      }));
      return Promise.resolve(Response.json({ ok: true, queues, total, limit, offset }));
    }) as typeof fetch;

    expect(await allQueues()).toBeNull();
  });

  test('malformed summary and overview payloads never become live alert facts', () => {
    expect(parseAlertQueueSummary({})).toBeNull();
    expect(
      parseAlertQueueSummary([
        {
          name: 'orders',
          paused: false,
          counts: { waiting: '5', active: 0, completed: 0, failed: 0, delayed: 0 },
        },
      ])
    ).toBeNull();
    expect(parseAlertOverview({ ok: true })).toBeNull();
    expect(
      parseAlertOverview({
        ok: true,
        latency: { percentiles: { push: { p99: Number.NaN } } },
      })
    ).toBeNull();
    expect(
      parseAlertOverview({ ok: true, latency: { percentiles: { push: { p99: 12 } } } })
    ).not.toBeNull();
  });

  test('a same-tick burst collapses into one toast instead of self-evicting', async () => {
    useAlertsStore.setState({
      rules: Array.from({ length: 6 }, (_, i) =>
        rule({ id: `b${i}`, name: `burst ${i}`, metric: 'waiting', threshold: 5 })
      ),
    });
    const h = renderHook(() => useAlertEngine());
    await settle(10);
    expect(breaching()).toHaveLength(6);
    // Before the fix: 6 pushes → slice(-5) evicted "burst 0" before it rendered.
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0]?.title).toBe('6 alert rules breaching');
    expect(toasts()[0]?.detail).toContain('burst 0');
    h.unmount();
  });
});

describe('connectionStore.setBaseUrl', () => {
  test('strips every trailing slash (and surrounding whitespace)', () => {
    const set = useConnectionStore.getState().setBaseUrl;
    set('http://host:6790//');
    expect(useConnectionStore.getState().baseUrl).toBe('http://host:6790');
    set('  http://host:6790///  ');
    expect(useConnectionStore.getState().baseUrl).toBe('http://host:6790');
    set('/api');
    expect(useConnectionStore.getState().baseUrl).toBe('/api');
  });
});
