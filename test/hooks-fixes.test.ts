import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { useActivityStream } from '../src/lib/useActivityStream';
import { usePolledData } from '../src/lib/usePolledData';
import { depthTrend, useThroughputSeries } from '../src/lib/useThroughputSeries';
import { renderHook, settle } from './domSetup';

// Regression tests for the audit fixes in the three polling/streaming hooks.
// Each one fails against the pre-fix implementation.

const realFetch = globalThis.fetch;
const realDateNow = Date.now;

const overview = () => ({
  ok: true,
  stats: {
    waiting: 2,
    active: 1,
    delayed: 3,
    completed: 10,
    dlq: 0,
    totalPushed: 20,
    totalPulled: 15,
    totalCompleted: 10,
    totalFailed: 1,
    uptime: 1000,
  },
  throughput: { pushPerSec: 5, completePerSec: 4, failPerSec: 1 },
});

const stats = () => ({
  ok: true,
  stats: {
    waiting: 2,
    prioritized: 0,
    active: 1,
    delayed: 3,
    completed: 10,
    dlq: 0,
    'waiting-children': 0,
    totalPushed: 20,
    totalPulled: 15,
    totalCompleted: 10,
    totalFailed: 1,
    uptime: 1000,
    pushPerSec: 5,
    pullPerSec: 4,
    completePerSec: 4,
    failPerSec: 1,
  },
});

const telemetryResponse = (input: RequestInfo | URL): Response =>
  Response.json(String(input).endsWith('/stats') ? stats() : overview());

afterEach(() => {
  globalThis.fetch = realFetch;
  Date.now = realDateNow;
  useConnectionStore.setState({ baseUrl: '/api', token: '' });
});

describe('useThroughputSeries — malformed /dashboard body', () => {
  beforeEach(() => {
    useConnectionStore.setState({ baseUrl: 'http://srv', token: '' });
  });

  test('a 200 body with no stats is a true no-op: latest stays null, error surfaces', async () => {
    globalThis.fetch = ((input) =>
      Promise.resolve(
        String(input).endsWith('/stats')
          ? Response.json(stats())
          : Response.json({ ok: true, throughput: { pushPerSec: 1 } })
      )) as typeof fetch;
    const h = renderHook(() => useThroughputSeries(60));
    await settle(20);
    expect(h.result.current.latest).toBeNull();
    expect(h.result.current.push).toEqual([]);
    expect(h.result.current.error).not.toBeNull();
    h.unmount();
  });

  test('a good sample clears the error and publishes latest', async () => {
    globalThis.fetch = ((input) => Promise.resolve(telemetryResponse(input))) as typeof fetch;
    const h = renderHook(() => useThroughputSeries(60));
    await settle(20);
    expect(h.result.current.error).toBeNull();
    expect(h.result.current.latest?.stats.waiting).toBe(2);
    h.unmount();
  });

  test('every sampled metric must be a finite number before latest is published', async () => {
    const corruptions: Array<[string, (body: ReturnType<typeof overview>) => void]> = [
      ['waiting', (body) => Object.assign(body.stats, { waiting: '2' })],
      ['active', (body) => Object.assign(body.stats, { active: null })],
      ['delayed', (body) => Object.assign(body.stats, { delayed: undefined })],
      ['pushPerSec', (body) => Object.assign(body.throughput, { pushPerSec: '5' })],
      ['completePerSec', (body) => Object.assign(body.throughput, { completePerSec: null })],
      ['failPerSec', (body) => Object.assign(body.throughput, { failPerSec: undefined })],
    ];

    for (const [, corrupt] of corruptions) {
      const body = overview();
      corrupt(body);
      globalThis.fetch = ((input) =>
        Promise.resolve(
          String(input).endsWith('/stats') ? Response.json(stats()) : Response.json(body)
        )) as typeof fetch;
      const h = renderHook(() => useThroughputSeries(60));
      await settle(10);
      expect(h.result.current.latest).toBeNull();
      expect(h.result.current.depth).toEqual([]);
      expect(h.result.current.error?.message).toContain('numeric metrics');
      h.unmount();
    }
  });
});

describe('useThroughputSeries — series integrity', () => {
  beforeEach(() => {
    useConnectionStore.setState({ baseUrl: 'http://srv', token: '' });
    globalThis.fetch = ((input) => Promise.resolve(telemetryResponse(input))) as typeof fetch;
  });

  test('retargeting the server clears the series instead of splicing two servers', async () => {
    const h = renderHook(() => useThroughputSeries(60));
    await settle(1200); // two samples from server A
    expect(h.result.current.depth.length).toBeGreaterThanOrEqual(2);

    await act(async () => {
      useConnectionStore.setState({ baseUrl: 'http://other-server' });
    });
    await settle(50);
    // Reset + the immediate first sample against server B: exactly one point.
    expect(h.result.current.depth.length).toBe(1);
    h.unmount();
  }, 10000);

  test('a long outage restarts the window; ordinary jitter does not', async () => {
    let healthy = true;
    let recovered = false;
    globalThis.fetch = ((input) => {
      if (!healthy) return Promise.resolve(Response.json({ ok: false, error: 'down' }));
      const body = String(input).endsWith('/stats') ? stats() : overview();
      if (recovered) body.stats.waiting = 100;
      return Promise.resolve(Response.json(body));
    }) as typeof fetch;

    const h = renderHook(() => useThroughputSeries(60));
    try {
      await settle(50);
      expect(h.result.current.depth.length).toBe(1);

      // A short hiccup (under the 4-interval slack) must NOT wipe the chart —
      // otherwise a backend answering slower than one interval leaves the window
      // permanently stuck at a single point.
      healthy = false;
      await settle(1600);
      healthy = true;
      await settle(1200);
      const afterJitter = h.result.current.depth.length;
      expect(afterJitter).toBeGreaterThanOrEqual(2);

      // A real outage does restart it: the points either side are seconds apart,
      // and the index→seconds axis would otherwise render them as adjacent 1 Hz
      // samples. Depending on the interval boundary, 1.2s can legitimately
      // admit one or two new points, so distinguish the new epoch by value.
      healthy = false;
      await settle(5200);
      expect(h.result.current.depth.length).toBe(afterJitter);
      recovered = true;
      healthy = true;
      await settle(1200);
      expect(h.result.current.depth.length).toBeGreaterThanOrEqual(1);
      expect(h.result.current.depth.every((value) => value === 104)).toBe(true);
    } finally {
      h.unmount();
    }
  }, 20000);
});

describe('depthTrend sample period', () => {
  test('a 2s-sampled series reports half the per-sample slope', () => {
    // A backlog truly growing +1 job/sec, sampled every 2s.
    expect(depthTrend([0, 2, 4, 6, 8], 2000).slope).toBeCloseTo(1);
    // Inside the ±0.05 jobs/sec dead band at the real sampling rate.
    expect(depthTrend([0, 0.08, 0.16, 0.24], 2000).label).toBe('steady');
    // Default stays the 1 Hz behaviour.
    expect(depthTrend([0, 2, 4, 6, 8]).slope).toBeCloseTo(2);
  });
});

describe('usePolledData — visibilitychange', () => {
  test('regaining focus mid-fetch does not issue a concurrent second fetch', async () => {
    let calls = 0;
    const h = renderHook(() =>
      usePolledData(
        async () => {
          calls += 1;
          await new Promise((r) => setTimeout(r, 150));
          return calls;
        },
        [],
        { intervalMs: 5000 }
      )
    );
    await settle(20); // first fetch is in flight
    expect(calls).toBe(1);

    const EventCtor = (globalThis.window as unknown as { Event: typeof Event }).Event;
    await act(async () => {
      for (let i = 0; i < 3; i++) {
        document.dispatchEvent(new EventCtor('visibilitychange'));
      }
      await new Promise((r) => setTimeout(r, 20));
    });
    // Pre-fix each event called load() beside the suspended loop → 4 in flight.
    expect(calls).toBe(1);

    await settle(200);
    expect(calls).toBe(1); // loop re-armed on its 5s timer, nothing extra
    h.unmount();
  }, 10000);
});

describe('useActivityStream — failure surface and monotonic window', () => {
  beforeEach(() => {
    useConnectionStore.setState({ baseUrl: 'http://srv', token: '' });
  });

  test('a permanently failing stream (HTTP 404) is reported through error', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response('nope', { status: 404 }))) as typeof fetch;
    const h = renderHook(() => useActivityStream());
    await settle(50);
    expect(h.result.current.connected).toBe(false);
    expect(h.result.current.error?.message).toContain('404');
    h.unmount();
  }, 10000);

  test('a backward wall-clock step still prunes the throughput window', async () => {
    const encoder = new TextEncoder();
    let ctrl: ReadableStreamDefaultController<Uint8Array> | undefined;
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              ctrl = c;
            },
          }),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
        )
      )) as typeof fetch;

    const h = renderHook(() => useActivityStream());
    await settle(20);
    for (let i = 0; i < 10; i++) {
      ctrl?.enqueue(encoder.encode(`event: job:pushed\ndata: {"queue":"q","jobId":"j${i}"}\n\n`));
    }
    await settle(1200);
    expect(h.result.current.throughput).toBeGreaterThan(0);

    // NTP steps the clock back an hour. Pre-fix, `now - ts < 5000` is satisfied
    // by every stale stamp, so nothing is ever pruned and the rate freezes.
    const frozen = realDateNow() - 3_600_000;
    Date.now = () => frozen;
    await settle(6000);
    expect(h.result.current.throughput).toBe(0);
    ctrl?.close();
    h.unmount();
  }, 20000);
});
