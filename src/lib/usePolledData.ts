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
 * Fetch `fetcher()` immediately and then on an interval, with three properties
 * that matter for a monitoring dashboard that mounts many of these at once:
 *
 *  1. **Self-scheduling** — the next poll is scheduled only AFTER the current
 *     one settles (recursive setTimeout, not setInterval), so at most one fetch
 *     per hook is ever in flight. A slow backend back-pressures instead of
 *     piling up overlapping fan-out requests.
 *  2. **Pause when hidden** — polling skips the fetch while the tab is in the
 *     background (Page Visibility API) and runs one immediate fetch on return,
 *     so a backgrounded dashboard costs the server nothing.
 *  3. **Sequence-guarded** — a resolution whose generation token is stale (deps
 *     changed, or a newer poll already started) is dropped, so switching a
 *     filter/page can't be clobbered by an older in-flight response.
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
  const [refreshing, setRefreshing] = useState(false);

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const mounted = useRef(true);
  const hasData = useRef(false);
  const gen = useRef(0);

  const load = useCallback(async () => {
    const myGen = ++gen.current;
    if (hasData.current) setRefreshing(true);
    try {
      const result = await fetcherRef.current();
      if (!mounted.current || myGen !== gen.current) return;
      setData(result);
      setError(null);
      hasData.current = true;
    } catch (e) {
      if (!mounted.current || myGen !== gen.current) return;
      setError(e as Error);
    } finally {
      if (mounted.current && myGen === gen.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    hasData.current = false;
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

  return { data, error, loading, refreshing, refetch: load };
}
