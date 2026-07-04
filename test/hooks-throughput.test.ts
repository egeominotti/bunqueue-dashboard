import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { depthTrend, useThroughputSeries } from '../src/lib/useThroughputSeries';
import { renderHook, settle } from './domSetup';

const realFetch = globalThis.fetch;

const overview = (waiting: number, pushPerSec: number) => ({
  ok: true,
  stats: { waiting, active: 1, delayed: 3 },
  throughput: { pushPerSec, completePerSec: 4, failPerSec: 1 },
});

let responder: () => Response;

beforeEach(() => {
  responder = () => Response.json(overview(2, 5));
  globalThis.fetch = (() => Promise.resolve(responder())) as typeof fetch;
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
    // depth = waiting + active + delayed = 2 + 1 + 3
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
