import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import {
  depthTrend,
  type ThroughputData,
  useThroughputSeries,
} from '../src/lib/useThroughputSeries';
import { renderHook, settle } from './domSetup';

const realFetch = globalThis.fetch;

const overview = (waiting: number, pushPerSec: number) => ({
  ok: true,
  stats: {
    waiting,
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
  throughput: { pushPerSec, completePerSec: 4, failPerSec: 1 },
});

const stats = (waiting: number, prioritized = 0, waitingChildren = 0) => ({
  ok: true,
  stats: {
    waiting,
    prioritized,
    active: 1,
    delayed: 3,
    completed: 10,
    dlq: 0,
    'waiting-children': waitingChildren,
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

let responder: (url: string) => Response;

beforeEach(() => {
  responder = (url) => Response.json(url.endsWith('/stats') ? stats(2) : overview(2, 5));
  globalThis.fetch = ((input) => Promise.resolve(responder(String(input)))) as typeof fetch;
  useConnectionStore.setState({ baseUrl: 'http://srv', token: '' });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  useConnectionStore.setState({ baseUrl: '/api', token: '' });
});

describe('useThroughputSeries', () => {
  test('first sample lands immediately: series filled, latest exposed, depth summed', async () => {
    const h = renderHook(() => useThroughputSeries(60));
    await settle(10);
    expect(h.result.current.push).toEqual([5]);
    expect(h.result.current.complete).toEqual([4]);
    expect(h.result.current.fail).toEqual([1]);
    // depth = waiting + prioritized + active + delayed + waiting-children
    expect(h.result.current.depth).toEqual([6]);
    expect(h.result.current.latest?.stats.waiting).toBe(2);
    h.unmount();
  });

  test('a failing sample is swallowed (transient), leaving the series empty', async () => {
    responder = () => Response.json({ ok: false, error: 'down' }, { status: 500 });
    const h = renderHook(() => useThroughputSeries(60));
    await settle(10);
    expect(h.result.current.push).toEqual([]);
    expect(h.result.current.latest).toBeNull();
    h.unmount();
  });

  test('an aborted sample from server A cannot publish after retargeting to server B', async () => {
    const pending: Array<{
      url: string;
      signal: AbortSignal | null;
      resolve: (response: Response) => void;
    }> = [];
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((resolve) => {
        pending.push({ url: String(input), signal: init?.signal ?? null, resolve });
      })) as typeof fetch;

    const h = renderHook(() => useThroughputSeries(60));
    await settle(5);
    expect(pending).toHaveLength(2);
    expect(pending.map((request) => request.url).sort()).toEqual([
      'http://srv/dashboard',
      'http://srv/stats',
    ]);

    await act(async () => {
      useConnectionStore.setState({ baseUrl: 'http://server-b' });
      await Promise.resolve();
    });
    await settle(5);
    expect(pending).toHaveLength(4);
    expect(pending[0].signal?.aborted).toBe(true);
    expect(pending[1].signal?.aborted).toBe(true);
    expect(
      pending
        .slice(2)
        .map((request) => request.url)
        .sort()
    ).toEqual(['http://server-b/dashboard', 'http://server-b/stats']);

    pending
      .find((request) => request.url === 'http://server-b/dashboard')
      ?.resolve(Response.json(overview(20, 9)));
    pending
      .find((request) => request.url === 'http://server-b/stats')
      ?.resolve(Response.json(stats(20)));
    await settle(10);
    expect(h.result.current.push).toEqual([9]);
    expect(h.result.current.depth).toEqual([24]);

    // Model a transport that ignores abort and resolves anyway: the generation
    // token, not abort cooperation, is the final publication guard.
    pending
      .find((request) => request.url === 'http://srv/dashboard')
      ?.resolve(Response.json(overview(2, 5)));
    pending.find((request) => request.url === 'http://srv/stats')?.resolve(Response.json(stats(2)));
    await settle(10);
    expect(h.result.current.push).toEqual([9]);
    expect(h.result.current.latest?.stats.waiting).toBe(20);
    h.unmount();
  });

  test('the first retarget render hides every sampler value owned by server A', async () => {
    let failA = false;
    const resolveB = new Map<string, (response: Response) => void>();
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('http://server-b/')) {
        return new Promise<Response>((resolve) => {
          resolveB.set(url, resolve);
        });
      }
      return Promise.resolve(
        failA
          ? Response.json({ error: 'server A sampler failed' }, { status: 502 })
          : Response.json(url.endsWith('/stats') ? stats(2) : overview(2, 5))
      );
    }) as typeof fetch;

    const renders: ThroughputData[] = [];
    const h = renderHook((windowSize: number) => {
      const snapshot = useThroughputSeries(windowSize);
      renders.push({
        ...snapshot,
        push: [...snapshot.push],
        complete: [...snapshot.complete],
        fail: [...snapshot.fail],
        depth: [...snapshot.depth],
      });
      return snapshot;
    }, 60);
    await settle(10);
    expect(h.result.current.latest?.stats.waiting).toBe(2);

    // Re-arm on the same connection and fail: the hook deliberately retains
    // A's last good chart/latest alongside an explicit A error.
    failA = true;
    h.rerender(61);
    await settle(10);
    expect(h.result.current.latest?.stats.waiting).toBe(2);
    expect(h.result.current.error?.message).toContain('server A sampler failed');

    const firstBRender = renders.length;
    act(() => useConnectionStore.setState({ baseUrl: 'http://server-b' }));
    const transitional = renders[firstBRender];
    expect(transitional).toBeDefined();
    expect(transitional.push).toEqual([]);
    expect(transitional.complete).toEqual([]);
    expect(transitional.fail).toEqual([]);
    expect(transitional.depth).toEqual([]);
    expect(transitional.latest).toBeNull();
    expect(transitional.error).toBeNull();

    resolveB.get('http://server-b/dashboard')?.(Response.json(overview(20, 9)));
    resolveB.get('http://server-b/stats')?.(Response.json(stats(20)));
    await settle(10);
    expect(h.result.current.latest?.stats.waiting).toBe(20);
    h.unmount();
  });

  test('depth includes prioritized and flow-blocked jobs from authoritative /stats', async () => {
    responder = (url) => Response.json(url.endsWith('/stats') ? stats(2, 5, 7) : overview(2, 5));
    const h = renderHook(() => useThroughputSeries(60));
    await settle(10);
    expect(h.result.current.depth).toEqual([18]);
    h.unmount();
  });
});

describe('depthTrend', () => {
  test('short series is steady', () => {
    expect(depthTrend([])).toEqual({ slope: 0, label: 'steady', draining: false });
    expect(depthTrend([5])).toEqual({ slope: 0, label: 'steady', draining: false });
  });

  test('rising backlog is accumulating (positive per-second slope)', () => {
    const t = depthTrend([0, 2, 4, 6, 8]);
    expect(t.slope).toBeCloseTo(2);
    expect(t.label).toBe('accumulating');
    expect(t.draining).toBe(false);
  });

  test('falling backlog is draining (negative slope)', () => {
    const t = depthTrend([8, 6, 4, 2, 0]);
    expect(t.slope).toBeCloseTo(-2);
    expect(t.label).toBe('draining');
    expect(t.draining).toBe(true);
  });

  test('flat backlog is steady within the ±0.05 dead band', () => {
    const t = depthTrend([5, 5, 5, 5]);
    expect(t.slope).toBe(0);
    expect(t.label).toBe('steady');
  });
});
