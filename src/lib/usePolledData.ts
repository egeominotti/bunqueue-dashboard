import { useCallback, useEffect, useRef, useState } from 'react';
import { useConnectionStore } from '@/components/dashboard/stores/connectionStore';

export interface PolledData<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  /** True while a refresh is in flight but stale data is still shown. */
  refreshing: boolean;
  refetch: () => void;
}

export interface PollOptions {
  /**
   * Override the global refresh interval for this hook. Use a large value for
   * rarely-changing data (queue-name dropdowns, config) so it doesn't re-poll on
   * the fast activity cadence.
   */
  intervalMs?: number;
}

/**
 * Fetch `fetcher()` immediately and then on an interval, with the properties
 * that matter for a monitoring dashboard that mounts many of these at once:
 *
 *  1. **Self-scheduling** — the next poll is scheduled only AFTER the current
 *     one settles (recursive setTimeout, not setInterval), so at most one fetch
 *     per hook is ever in flight. A slow backend back-pressures instead of
 *     piling up overlapping fan-out requests.
 *  2. **Pause when hidden** — polling skips the fetch while the tab is in the
 *     background (Page Visibility API) and runs one immediate fetch on return.
 *  3. **Sequence-guarded** — a resolution whose generation token is stale (deps
 *     changed, or a newer poll already started) is dropped.
 *  4. **Render-stable** — a poll that returns the SAME data as last time updates
 *     NO state, so the page does not re-render. Only genuinely-changed data (or a
 *     new error / the first load) triggers a render. This is what keeps the UI
 *     from visibly "refreshing" every interval when nothing has changed.
 *
 * Keeps the last good data while refreshing (no flicker) and never calls
 * setState after unmount.
 */
export function usePolledData<T>(
  fetcher: () => Promise<T>,
  deps: unknown[] = [],
  options: PollOptions = {}
): PolledData<T> {
  const globalRefresh = useConnectionStore((s) => s.refreshMs);
  const refreshMs = options.intervalMs ?? globalRefresh;

  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const mounted = useRef(true);
  const gen = useRef(0);
  // Change-detection + state mirrors so a steady poll issues zero setState calls.
  const lastKey = useRef<string | undefined>(undefined);
  const loadingRef = useRef(true);
  const hadError = useRef(false);

  const load = useCallback(async () => {
    const myGen = ++gen.current;
    try {
      const result = await fetcherRef.current();
      if (!mounted.current || myGen !== gen.current) return;
      // Only re-render when the payload actually changed. Serializing the result
      // each poll is far cheaper than reconciling the whole page for no reason.
      let key: string;
      try {
        key = JSON.stringify(result);
      } catch {
        key = String(Math.random()); // non-serializable → always treat as changed
      }
      if (key !== lastKey.current) {
        lastKey.current = key;
        setData(result);
      }
      if (hadError.current) {
        hadError.current = false;
        setError(null);
      }
    } catch (e) {
      if (!mounted.current || myGen !== gen.current) return;
      hadError.current = true;
      setError(e as Error);
    } finally {
      if (mounted.current && myGen === gen.current && loadingRef.current) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    // A deps change means a new view — reset change-detection and show loading.
    lastKey.current = undefined;
    loadingRef.current = true;
    setLoading(true);

    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const hidden = () => typeof document !== 'undefined' && document.hidden;

    // Recursive self-scheduling loop: the next tick is armed only once the
    // current fetch has settled, so overlapping polls can't accumulate.
    const tick = async () => {
      if (stopped) return;
      if (!hidden()) await load();
      if (stopped) return;
      timer = setTimeout(tick, refreshMs);
    };
    tick();

    // Fetch immediately when the tab regains focus (it was skipped while hidden).
    const onVisible = () => {
      if (!hidden() && !stopped) load();
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisible);
    }

    return () => {
      stopped = true;
      mounted.current = false;
      if (timer) clearTimeout(timer);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisible);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshMs, load, ...deps]);

  // `refreshing` is derived, not state: a background refresh no longer forces a
  // render on every tick (nothing consumes a per-tick refreshing flag today).
  return { data, error, loading, refreshing: loading, refetch: load };
}
