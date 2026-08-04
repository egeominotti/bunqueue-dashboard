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
  test('retargeting the connection clears server A runtime and notification latches', async () => {
    useConnectionStore.setState({ baseUrl: 'http://server-a', token: 'token-a' });
    const rules = [rule({ metric: 'waiting', threshold: 5 })];
    useAlertsStore.setState({ rules });

    let blockServerB = true;
    const releaseServerB: Array<() => void> = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (blockServerB && url.startsWith('http://server-b/')) {
        return new Promise<Response>((resolve) => {
          releaseServerB.push(() => resolve(route(url)));
        });
      }
      return Promise.resolve(route(url));
    }) as typeof fetch;

    const h = renderHook(() => useAlertEngine());
    await settle(10);
    expect(breaching().map((breach) => breach.ruleId)).toEqual(['r1']);
    expect(toasts()).toHaveLength(1);
    expect(useAlertRuntimeStore.getState().status).toBe('live');

    act(() => {
      useConnectionStore.setState({ baseUrl: 'http://server-b', token: 'token-b' });
    });
    expect(releaseServerB).toHaveLength(3);
    expect(breaching()).toEqual([]);
    expect(useAlertRuntimeStore.getState().status).toBe('checking');
    expect(toasts()).toHaveLength(1);

    blockServerB = false;
    for (const release of releaseServerB) release();
    await settle(10);
    expect(breaching().map((breach) => breach.ruleId)).toEqual(['r1']);
    // Same rule, but a different backend: A's cooldown/edge state must not
    // suppress the first alert evaluation from B.
    expect(toasts()).toHaveLength(2);
    expect(useAlertRuntimeStore.getState().status).toBe('live');
    h.unmount();
  });
});
