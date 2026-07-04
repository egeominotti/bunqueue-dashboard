import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { type AlertRule, useAlertsStore } from '../src/components/dashboard/stores/alertsStore';
import { useToastStore } from '../src/components/dashboard/stores/toastStore';
import { useAlertEngine, useAlertRuntimeStore } from '../src/lib/useAlertEngine';
import { renderHook, settle } from './domSetup';

// Client-side alert engine: rule evaluation against mocked metric endpoints,
// the null-vs-zero policy for failed sources, edge-triggered notification, and
// the idle path when no rule is enabled.

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

const summaryRow = (name: string, counts: Partial<Record<string, number>>) => ({
  name,
  counts: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, ...counts },
});

let failSummary = false;
let failOverview = false;
let fetchCalls = 0;
const realFetch = globalThis.fetch;

function route(url: string): Response {
  if (url.includes('/queues/summary')) {
    if (failSummary) return Response.json({ ok: false, error: 'boom' }, { status: 500 });
    return Response.json([summaryRow('q1', { waiting: 10, completed: 90, failed: 10 })]);
  }
  if (url.includes('/dashboard/queues')) {
    return Response.json({ ok: true, queues: [{ name: 'q1', dlq: 7 }] });
  }
  if (url.endsWith('/dashboard')) {
    if (failOverview) return Response.json({ ok: false, error: 'down' }, { status: 500 });
    return Response.json({
      ok: true,
      latency: { percentiles: { push: { p99: 120 }, pull: { p99: 80 } } },
    });
  }
  return Response.json({ ok: true });
}

beforeEach(() => {
  failSummary = false;
  failOverview = false;
  fetchCalls = 0;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    fetchCalls += 1;
    return Promise.resolve(route(String(input)));
  }) as typeof fetch;
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

describe('useAlertEngine', () => {
  test('a crossed threshold produces a breach and exactly one toast', async () => {
    useAlertsStore.setState({ rules: [rule({ metric: 'waiting', threshold: 5 })] });
    const h = renderHook(() => useAlertEngine());
    await settle(10);

    expect(breaching()).toHaveLength(1);
    expect(breaching()[0]).toMatchObject({ ruleId: 'r1', value: 10, threshold: 5 });
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0]?.title).toBe('Alert: test rule');
    h.unmount();
  });

  test('a still-breaching rule is NOT re-notified when the poller re-arms (edge-triggered)', async () => {
    useAlertsStore.setState({ rules: [rule({ threshold: 5 })] });
    const h = renderHook(() => useAlertEngine());
    await settle(10);
    expect(toasts()).toHaveLength(1);

    // Changing the rule set re-arms the effect and runs an immediate tick; the
    // rule still breaches, but it was already breaching — no second toast.
    act(() => {
      useAlertsStore.setState({ rules: [rule({ threshold: 4 })] });
    });
    await settle(10);
    expect(breaching()).toHaveLength(1);
    expect(toasts()).toHaveLength(1);
    h.unmount();
  });

  test('overview down ⇒ the whole tick is skipped (no false trip of <-rules)', async () => {
    failOverview = true;
    // A `<`-rule that WOULD trip if absent data were read as zero.
    useAlertsStore.setState({
      rules: [rule({ metric: 'waiting', operator: '<', threshold: 100 })],
    });
    const h = renderHook(() => useAlertEngine());
    await settle(10);
    expect(breaching()).toHaveLength(0);
    expect(toasts()).toHaveLength(0);
    h.unmount();
  });

  test('a failed source nulls only ITS metrics; others still evaluate', async () => {
    failSummary = true;
    useAlertsStore.setState({
      rules: [
        rule({ id: 'w', metric: 'waiting', threshold: 1 }), // summary-backed → unknown → skipped
        rule({ id: 'd', metric: 'dlq', threshold: 5 }), // queues-backed → evaluates (7 >= 5)
      ],
    });
    const h = renderHook(() => useAlertEngine());
    await settle(10);
    expect(breaching().map((b) => b.ruleId)).toEqual(['d']);
    expect(breaching()[0]?.value).toBe(7);
    h.unmount();
  });

  test('queue-scoped rule reads that queue; a missing queue is unknown, not zero', async () => {
    useAlertsStore.setState({
      rules: [
        rule({ id: 'hit', queue: 'q1', metric: 'failed', threshold: 10 }),
        rule({ id: 'ghost', queue: 'nope', metric: 'waiting', operator: '<', threshold: 100 }),
      ],
    });
    const h = renderHook(() => useAlertEngine());
    await settle(10);
    expect(breaching().map((b) => b.ruleId)).toEqual(['hit']);
    h.unmount();
  });

  test('p99_latency evaluates the max per-operation p99', async () => {
    useAlertsStore.setState({
      rules: [rule({ metric: 'p99_latency', operator: '>', threshold: 100 })],
    });
    const h = renderHook(() => useAlertEngine());
    await settle(10);
    expect(breaching()[0]?.value).toBe(120);
    h.unmount();
  });

  test('no enabled rules ⇒ no polling at all', async () => {
    useAlertsStore.setState({ rules: [rule({ enabled: false })] });
    const h = renderHook(() => useAlertEngine());
    await settle(10);
    expect(fetchCalls).toBe(0);
    expect(breaching()).toHaveLength(0);
    h.unmount();
  });
});
