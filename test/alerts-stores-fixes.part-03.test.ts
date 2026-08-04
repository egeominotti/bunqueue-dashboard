import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { type AlertRule, useAlertsStore } from '../src/components/dashboard/stores/alertsStore';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { useToastStore } from '../src/components/dashboard/stores/toastStore';
import { allQueues, useAlertEngine, useAlertRuntimeStore } from '../src/lib/useAlertEngine';
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
  test('zero-sample queue and global error rates stay unknown for both inequality directions', async () => {
    completed = 0;
    failed = 0;
    useAlertsStore.setState({
      rules: [
        rule({
          id: 'queue-less-than',
          metric: 'error_rate',
          operator: '<',
          threshold: 1,
          queue: 'q1',
        }),
        rule({
          id: 'global-greater-than',
          metric: 'error_rate',
          operator: '>',
          threshold: 1,
          queue: '',
        }),
      ],
    });

    const h = renderHook(() => useAlertEngine());
    await settle(10);

    expect(breaching()).toEqual([]);
    expect(useAlertRuntimeStore.getState()).toMatchObject({
      status: 'degraded',
      error: 'Some alert rules could not be evaluated; affected results remain unknown.',
    });
    expect(toasts()).toEqual([]);
    h.unmount();
  });

  test('missing queues and empty percentile sets cannot publish an all-clear status', async () => {
    emptyPercentiles = true;
    useAlertsStore.setState({
      rules: [
        rule({
          id: 'missing-queue',
          metric: 'waiting',
          operator: '<',
          threshold: 1,
          queue: 'does-not-exist',
        }),
        rule({
          id: 'empty-p99',
          metric: 'p99_latency',
          operator: '>',
          threshold: 1,
          queue: '',
        }),
      ],
    });

    const h = renderHook(() => useAlertEngine());
    await settle(10);

    expect(breaching()).toEqual([]);
    expect(useAlertRuntimeStore.getState().status).toBe('degraded');
    expect(useAlertRuntimeStore.getState().error).toContain('remain unknown');
    h.unmount();
  });

  test('the cooldown defers a suppressed edge instead of dropping it forever', async () => {
    const realNow = Date.now;
    let clock = 1_000_000;
    Date.now = () => clock;
    try {
      const rules = [rule({ metric: 'waiting', threshold: 5 })];
      useAlertsStore.setState({ rules });
      const h = renderHook(() => useAlertEngine());
      await settle(10);
      expect(toasts()).toHaveLength(1);

      // Dips below the threshold for one tick …
      clock += 15_000;
      waiting = 0;
      await retick(1, rules);
      expect(breaching()).toHaveLength(0);

      // … then re-breaches inside the 60 s cooldown: suppressed, not consumed.
      clock += 15_000;
      waiting = 10;
      await retick(2, rules);
      expect(breaching()).toHaveLength(1);
      expect(toasts()).toHaveLength(1);

      // Still breaching once the cooldown has expired ⇒ exactly one notification.
      clock += 70_000;
      await retick(3, rules);
      expect(toasts()).toHaveLength(2);

      // …and not a second one for the same episode.
      clock += 70_000;
      await retick(4, rules);
      expect(toasts()).toHaveLength(2);
      h.unmount();
    } finally {
      Date.now = realNow;
    }
  });

  test('a rule deleted while the server is down loses its triggered row', async () => {
    const a = rule({ id: 'a', name: 'noisy', metric: 'waiting', threshold: 5 });
    const b = rule({ id: 'b', name: 'quiet', metric: 'dlq', operator: '>', threshold: 1e9 });
    useAlertsStore.setState({ rules: [a, b] });
    const h = renderHook(() => useAlertEngine());
    await settle(10);
    expect(breaching().map((x) => x.ruleId)).toEqual(['a']);

    failOverview = true;
    act(() => {
      useAlertsStore.setState({ rules: [b] });
    });
    await settle(10);
    expect(breaching()).toEqual([]);
    h.unmount();
  });

  test('the dlq metric sees queues beyond the first page', async () => {
    queueCount = 600; // > bq.queues()'s default limit of 500
    useAlertsStore.setState({
      rules: [rule({ id: 'tail', metric: 'dlq', queue: 'q600', threshold: 5 })],
    });
    const h = renderHook(() => useAlertEngine());
    await settle(20);
    expect(breaching().map((x) => x.ruleId)).toEqual(['tail']);
    expect(breaching()[0]?.value).toBe(7);
    h.unmount();
  });

  test('allQueues uses a supplied pinned client for every continuation page', async () => {
    const offsets: number[] = [];
    const client = {
      queues: async (limit = 500, offset = 0) => {
        offsets.push(offset);
        if (offset === 0) {
          useConnectionStore.setState({ baseUrl: 'http://server-b', token: 'token-b' });
        }
        const queues = Array.from({ length: Math.min(limit, 600 - offset) }, (_, index) => ({
          name: `q${offset + index + 1}`,
          waiting: 0,
          delayed: 0,
          active: 0,
          dlq: 0,
          paused: false,
        }));
        return { ok: true as const, queues, total: 600, limit, offset, timestamp: 0 };
      },
    };

    expect(await allQueues(client)).toHaveLength(600);
    expect(offsets).toEqual([0, 500]);
  });
});
