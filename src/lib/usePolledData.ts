import { useCallback, useEffect, useRef, useState } from 'react';
import { useConnectionStore } from '@/components/dashboard/stores/connectionStore';

export interface PolledData<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  /** Resolves after the requested (or coalesced follow-up) refresh settles. */
  refetch: () => Promise<void>;
}

/**
 * Gate for a poll loop's visibility rule: the FIRST tick always fetches — a
 * view opened in a background tab (cmd-click) must not sit on "Loading…"
 * until focused — while later ticks fetch only when visible. `first` is
 * consumed only when the gate answers, so callers must ask it *after* any
 * other skip conditions (e.g. an in-flight guard) or the first tick is lost.
 * Pure factory, exported for tests.
 */
export function createPollGate(isHidden: () => boolean): () => boolean {
  let first = true;
  return () => {
    if (first) {
      first = false;
      return true;
    }
    return !isHidden();
  };
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
  fetcher: (signal: AbortSignal) => Promise<T>,
  deps: unknown[] = [],
  options: PollOptions = {}
): PolledData<T> {
  const globalRefresh = useConnectionStore((s) => s.refreshMs);
  // Pollers must retarget immediately when Settings/AuthGate changes either
  // backend credential. Without this dependency, rows from server A remained
  // actionable while bq/api mutations already pointed at server B.
  const connectionIdentity = useConnectionStore((s) =>
    JSON.stringify([s.baseUrl, s.token, s.agentToken])
  );
  const refreshMs = options.intervalMs ?? globalRefresh;

  // Compute a render-time view generation from the connection plus caller
  // deps. This gates old state during the render that changes queue/server,
  // before the passive effect gets a chance to clear it. All comparisons use
  // Object.is, matching React's dependency semantics without serializing data.
  const renderedInputs = useRef<unknown[] | null>(null);
  const viewVersionRef = useRef(0);
  const nextInputs = [connectionIdentity, ...deps];
  const inputsChanged =
    renderedInputs.current === null ||
    renderedInputs.current.length !== nextInputs.length ||
    renderedInputs.current.some((value, index) => !Object.is(value, nextInputs[index]));
  if (inputsChanged) {
    renderedInputs.current = nextInputs;
    viewVersionRef.current += 1;
  }
  const viewVersion = viewVersionRef.current;

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
  const publishedView = useRef(0);
  const errorView = useRef(0);
  // The public refetch callback stays stable while each effect generation
  // installs its own scheduler behind it.
  const schedulerRef = useRef<() => Promise<void>>(() => Promise.resolve());

  const load = useCallback(async (myGen: number, myView: number, signal: AbortSignal) => {
    try {
      const result = await fetcherRef.current(signal);
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
        publishedView.current = myView;
        setData(result);
      } else {
        publishedView.current = myView;
      }
      if (hadError.current) {
        hadError.current = false;
        errorView.current = 0;
        setError(null);
      }
    } catch (e) {
      if (!mounted.current || myGen !== gen.current) return;
      hadError.current = true;
      errorView.current = myView;
      setError(e as Error);
    } finally {
      if (mounted.current && myGen === gen.current && loadingRef.current) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  }, []);

  const refetch = useCallback(() => schedulerRef.current(), []);

  useEffect(() => {
    mounted.current = true;
    const myGen = ++gen.current;
    // Every dependency/connection generation owns one cancellation signal.
    // Sequence guards keep stale results out of React state, while aborting the
    // underlying work also stops expensive multi-request fetchers after a
    // retarget or unmount instead of letting them consume the old server.
    const lifecycle = new AbortController();
    // A deps/connection change means a new view. Invalidate the published
    // payload synchronously with this effect: keeping it would render queue A's
    // rows under queue B (and could make actions target the wrong backend).
    lastKey.current = undefined;
    loadingRef.current = true;
    setData(null);
    setLoading(true);
    if (hadError.current) {
      hadError.current = false;
      setError(null);
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let running = false;
    let refreshPending = false;
    let pendingRefreshResolvers: Array<() => void> = [];
    const hidden = () => globalThis.document?.hidden ?? false;
    const gate = createPollGate(hidden);

    const clearTimer = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };

    const armNextTick = () => {
      if (stopped) return;
      clearTimer();
      timer = setTimeout(() => {
        timer = null;
        void request(false);
      }, refreshMs);
    };

    // One scheduler owns interval ticks AND public refetches. A refetch that
    // arrives mid-flight sets one coalesced pending bit; it runs immediately
    // after the current request instead of overlapping it or being discarded.
    const run = async (): Promise<void> => {
      running = true;
      try {
        await load(myGen, viewVersion, lifecycle.signal);
      } finally {
        running = false;
        if (!stopped) {
          if (refreshPending) {
            refreshPending = false;
            const resolvers = pendingRefreshResolvers;
            pendingRefreshResolvers = [];
            void request(true).finally(() => {
              for (const resolve of resolvers) resolve();
            });
          } else {
            armNextTick();
          }
        }
      }
    };

    function request(force: boolean): Promise<void> {
      if (stopped) return Promise.resolve();
      if (running) {
        if (!force) return Promise.resolve();
        refreshPending = true;
        return new Promise((resolve) => pendingRefreshResolvers.push(resolve));
      }
      clearTimer();
      // The gate lets the FIRST interval fetch run even while hidden; explicit
      // refetches are always honored because callers requested fresh data now.
      if (!force && !gate()) {
        armNextTick();
        return Promise.resolve();
      }
      return run();
    }

    const scheduleRefresh = () => request(true);
    schedulerRef.current = scheduleRefresh;
    void request(false);

    // Fetch immediately when the tab regains focus (it was skipped while
    // hidden) — by re-driving the loop, not by calling load() beside it. A
    // direct call raced the suspended tick(), so N alt-tabs during one slow
    // fetch issued N+1 concurrent requests. If a fetch is already running the
    // loop will re-arm on its own, so there is nothing to do.
    const onVisible = () => {
      if (hidden() || stopped || running) return;
      void request(true);
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisible);
    }

    return () => {
      stopped = true;
      mounted.current = false;
      lifecycle.abort();
      clearTimer();
      for (const resolve of pendingRefreshResolvers) resolve();
      pendingRefreshResolvers = [];
      if (schedulerRef.current === scheduleRefresh) {
        schedulerRef.current = () => Promise.resolve();
      }
      if (gen.current === myGen) gen.current += 1;
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisible);
      }
    };
  }, [refreshMs, viewVersion, load]);

  const dataBelongsToView = publishedView.current === viewVersion;
  const errorBelongsToView = errorView.current === viewVersion;
  return {
    data: dataBelongsToView ? data : null,
    error: errorBelongsToView ? error : null,
    loading: dataBelongsToView || errorBelongsToView ? loading : true,
    refetch,
  };
}
