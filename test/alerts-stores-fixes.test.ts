import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { type AlertRule, useAlertsStore } from '../src/components/dashboard/stores/alertsStore';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { useToastStore } from '../src/components/dashboard/stores/toastStore';
import { useAlertEngine, useAlertRuntimeStore } from '../src/lib/useAlertEngine';
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
let failSummary = false;
let failOverview = false;
let queueCount = 1;
const realFetch = globalThis.fetch;

function route(url: string): Response {
  if (url.includes('/queues/summary')) {
    if (failSummary) return Response.json({ ok: false, error: 'boom' }, { status: 500 });
    return Response.json([
      { name: 'q1', counts: { waiting, active: 0, completed: 90, failed: 10, delayed: 0 } },
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
    return Response.json({ ok: true, latency: { percentiles: { push: { p99: 120 } } } });
  }
  return Response.json({ ok: true });
}

beforeEach(() => {
  waiting = 10;
  failSummary = false;
  failOverview = false;
  queueCount = 1;
  globalThis.fetch = ((input: RequestInfo | URL) =>
    Promise.resolve(route(String(input)))) as typeof fetch;
  useAlertsStore.setState({ rules: [] });
  useAlertRuntimeStore.setState({ breaching: [] });
  useToastStore.setState({ toasts: [] });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  useAlertsStore.setState({ rules: [] });
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
