import { describe, expect, test } from 'bun:test';
import { act } from 'react';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { usePolledData } from '../src/lib/usePolledData';
import { renderHook, settle } from './domSetup';

// Behavioral tests for the core polling hook, with real (short) timers: initial
// load, self-scheduled re-polls, render stability on unchanged payloads, error
// set/clear, the generation guard on deps changes, refetch, and unmount.

const INTERVAL = 20;

describe('usePolledData', () => {
  test('loads immediately, then re-polls on the interval', async () => {
    let calls = 0;
    const h = renderHook(() =>
      usePolledData(
        async () => {
          calls += 1;
          return { n: calls };
        },
        [],
        { intervalMs: INTERVAL }
      )
    );
    expect(h.result.current.loading).toBe(true);
    expect(h.result.current.data).toBeNull();

    await settle(5);
    expect(h.result.current.loading).toBe(false);
    expect(h.result.current.data).toEqual({ n: 1 });

    await settle(INTERVAL * 4);
    expect(calls).toBeGreaterThanOrEqual(3);
    h.unmount();
  });

  test('render-stable: an unchanged payload keeps the same data reference', async () => {
    // A fresh object with identical content every poll — the JSON change
    // detection must NOT push it into state (no re-render churn).
    const h = renderHook(() =>
      usePolledData(async () => ({ status: 'ok', count: 7 }), [], { intervalMs: INTERVAL })
    );
    await settle(5);
    const first = h.result.current.data;
    expect(first).toEqual({ status: 'ok', count: 7 });

    await settle(INTERVAL * 4);
    expect(h.result.current.data).toBe(first);
    h.unmount();
  });

  test('a changed payload replaces data; an error is set and then cleared on recovery', async () => {
    let mode: 'a' | 'fail' | 'b' = 'a';
    const h = renderHook(() =>
      usePolledData(
        async () => {
          if (mode === 'fail') throw new Error('backend down');
          return { mode };
        },
        [],
        { intervalMs: INTERVAL }
      )
    );
    await settle(5);
    expect(h.result.current.data).toEqual({ mode: 'a' });

    mode = 'fail';
    await settle(INTERVAL * 3);
    expect(h.result.current.error?.message).toBe('backend down');
    // Stale data is kept while erroring (no flicker to empty).
    expect(h.result.current.data).toEqual({ mode: 'a' });

    mode = 'b';
    await settle(INTERVAL * 3);
    expect(h.result.current.error).toBeNull();
    expect(h.result.current.data).toEqual({ mode: 'b' });
    h.unmount();
  });

  test('generation guard: a stale in-flight result from before a deps change is dropped', async () => {
    let releaseStale: (() => void) | undefined;
    const h = renderHook(
      (dep: string) =>
        usePolledData(
          () =>
            dep === 'old'
              ? new Promise<{ dep: string }>((resolve) => {
                  releaseStale = () => resolve({ dep: 'old' });
                })
              : Promise.resolve({ dep }),
          [dep],
          { intervalMs: 5000 }
        ),
      'old'
    );
    await settle(5);
    expect(releaseStale).toBeDefined();
    expect(h.result.current.data).toBeNull(); // old fetch still pending

    h.rerender('new');
    await settle(5);
    expect(h.result.current.data).toEqual({ dep: 'new' });

    // The pre-change fetch finally resolves — its generation is stale, so it
    // must NOT clobber the new view's data.
    releaseStale?.();
    await settle(5);
    expect(h.result.current.data).toEqual({ dep: 'new' });
    h.unmount();
  });

  test('a published payload is hidden immediately while the next dependency view loads', async () => {
    let releaseNew: (() => void) | undefined;
    const h = renderHook(
      (dep: string) =>
        usePolledData(
          () =>
            dep === 'old'
              ? Promise.resolve({ dep })
              : new Promise<{ dep: string }>((resolve) => {
                  releaseNew = () => resolve({ dep });
                }),
          [dep],
          { intervalMs: 5000 }
        ),
      'old'
    );
    await settle(5);
    expect(h.result.current.data).toEqual({ dep: 'old' });

    h.rerender('new');
    // Never expose old queue/page data under the new controls while its request
    // is pending — this is observable in the same render, before effects settle.
    expect(h.result.current.data).toBeNull();
    expect(h.result.current.loading).toBe(true);

    releaseNew?.();
    await settle(5);
    expect(h.result.current.data).toEqual({ dep: 'new' });
    h.unmount();
  });

  test('retargets immediately and hides server A data when the connection store changes', async () => {
    useConnectionStore.setState({ baseUrl: 'http://server-a', token: 'a', agentToken: '' });
    let releaseB: (() => void) | undefined;
    const calls: string[] = [];
    const h = renderHook(() =>
      usePolledData(
        () => {
          const target = useConnectionStore.getState().baseUrl;
          calls.push(target);
          return target.endsWith('server-a')
            ? Promise.resolve({ target })
            : new Promise<{ target: string }>((resolve) => {
                releaseB = () => resolve({ target });
              });
        },
        [],
        { intervalMs: 5000 }
      )
    );
    await settle(5);
    expect(h.result.current.data).toEqual({ target: 'http://server-a' });

    act(() => useConnectionStore.getState().setBaseUrl('http://server-b'));
    expect(h.result.current.data).toBeNull();
    expect(h.result.current.loading).toBe(true);
    expect(calls.at(-1)).toBe('http://server-b');

    releaseB?.();
    await settle(5);
    expect(h.result.current.data).toEqual({ target: 'http://server-b' });
    h.unmount();
    useConnectionStore.setState({ baseUrl: '/api', token: '', agentToken: '' });
  });

  test('refetch() triggers an immediate out-of-cycle fetch', async () => {
    let calls = 0;
    const h = renderHook(() =>
      usePolledData(
        async () => {
          calls += 1;
          return calls;
        },
        [],
        { intervalMs: 5000 }
      )
    );
    await settle(5);
    expect(calls).toBe(1);

    await act(async () => h.result.current.refetch());
    expect(calls).toBe(2);
    expect(h.result.current.data).toBe(2);
    h.unmount();
  });

  test('refetches coalesce behind the in-flight tick without overlap or a lost refresh', async () => {
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];
    const h = renderHook(() =>
      usePolledData(
        () => {
          const value = ++calls;
          active += 1;
          maxActive = Math.max(maxActive, active);
          return new Promise<number>((resolve) => {
            releases.push(() => {
              active -= 1;
              resolve(value);
            });
          });
        },
        [],
        { intervalMs: 5000 }
      )
    );
    await settle(5);
    expect(calls).toBe(1);

    // Pre-fix refetch called load() beside tick(): all three requests overlapped
    // and generation invalidation could discard the tick response. Now they set
    // one pending bit and guarantee exactly one immediate follow-up.
    h.result.current.refetch();
    h.result.current.refetch();
    h.result.current.refetch();
    await settle(5);
    expect(calls).toBe(1);
    expect(maxActive).toBe(1);

    releases.shift()?.();
    await settle(5);
    expect(calls).toBe(2);
    expect(active).toBe(1);
    expect(maxActive).toBe(1);

    releases.shift()?.();
    await settle(5);
    expect(h.result.current.data).toBe(2);
    expect(calls).toBe(2);
    h.unmount();
  });

  test('unmount stops the poll loop', async () => {
    let calls = 0;
    const h = renderHook(() =>
      usePolledData(
        async () => {
          calls += 1;
          return calls;
        },
        [],
        { intervalMs: INTERVAL }
      )
    );
    await settle(5);
    h.unmount();
    const after = calls;
    await new Promise((resolve) => setTimeout(resolve, INTERVAL * 4));
    expect(calls).toBe(after);
  });
});
