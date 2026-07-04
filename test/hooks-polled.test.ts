import { describe, expect, test } from 'bun:test';
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

    h.result.current.refetch();
    await settle(5);
    expect(calls).toBe(2);
    expect(h.result.current.data).toBe(2);
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
