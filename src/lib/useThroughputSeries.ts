import { useEffect, useRef, useState } from 'react';
import { useConnectionStore } from '@/components/dashboard/stores/connectionStore';
import { bq } from './bq';
import { createPollGate } from './usePolledData';

export interface ThroughputSeries {
  push: number[];
  complete: number[];
  fail: number[];
  /** Backlog depth over time: waiting + active + delayed. */
  depth: number[];
}

/**
 * Samples the server's per-second throughput AND queue-depth once a second into
 * a rolling window, for the live charts. One poller feeds both series (no extra
 * request). Independent of the page poll interval.
 */
type Overview = Awaited<ReturnType<typeof bq.overview>>;

export interface ThroughputData extends ThroughputSeries {
  /** Latest full /dashboard overview, so a consuming page needn't poll it too. */
  latest: Overview | null;
  /**
   * Last sampling failure (request error OR malformed /dashboard body), cleared
   * by the next good sample. Without it a dead sampler is indistinguishable
   * from a genuinely idle server: the page would render zeros as live data.
   */
  error: Error | null;
}

/** Sampling period of the poller below — the time base of every series index. */
const SAMPLE_MS = 1000;

const EMPTY_SERIES: ThroughputSeries = { push: [], complete: [], fail: [], depth: [] };

/** Monotonic clock: gap detection must survive an NTP/manual wall-clock step. */
const monoNow = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Connection identity for the retarget check. Separated by an escaped NUL — a
 * byte that appears in neither a URL nor a token, so two distinct connections
 * can never collide. Written as an escape, never as a literal NUL byte: that
 * makes git classify this source file as binary and its diff unreviewable.
 */
const connectionKey = (baseUrl: string, token: string): string => `${baseUrl}\u0000${token}`;

export function useThroughputSeries(windowSize = 60): ThroughputData {
  const baseUrl = useConnectionStore((s) => s.baseUrl);
  const token = useConnectionStore((s) => s.token);

  const [series, setSeries] = useState<ThroughputSeries>(EMPTY_SERIES);
  const [latest, setLatest] = useState<Overview | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const lastSampleAt = useRef(0);
  const connKey = useRef(connectionKey(baseUrl, token));

  useEffect(() => {
    mounted.current = true;
    // Retargeting Settings ▸ Server URL (or the token) points the very next
    // sample at a DIFFERENT server: keeping the old points would splice two
    // servers into one chart and fabricate a `draining` trend. Mirrors the
    // reset useActivityStream does on the same deps.
    const key = connectionKey(baseUrl, token);
    if (connKey.current !== key) {
      connKey.current = key;
      setSeries(EMPTY_SERIES);
      setLatest(null);
      setError(null);
      lastSampleAt.current = 0;
    }
    const gate = createPollGate(() => typeof document !== 'undefined' && document.hidden);
    const tick = async () => {
      // Skip if the previous request hasn't returned yet — a slow /dashboard
      // (>1s) would otherwise overlap requests and produce out-of-order
      // samples. Checked BEFORE the gate so an in-flight skip can't consume
      // the gate's one always-run first tick.
      if (inFlight.current) return;
      // The gate skips recurring samples while the tab is hidden — the chart
      // isn't visible — but lets the FIRST sample run so `latest` (Server
      // Overview, totals) isn't a zeroed placeholder in a background tab.
      if (!gate()) return;
      inFlight.current = true;
      // Stamped BEFORE the request: the gap check below must measure
      // tick-to-tick spacing, not response latency, or a backend answering
      // slower than one interval would look like a hole on every sample.
      const tickAt = monoNow();
      try {
        const o = await bq.overview();
        if (!mounted.current) return;
        // Read EVERY field before publishing anything: bq.call() validates only
        // `ok`, so a 200 with a drifted/foreign body would otherwise commit
        // `latest` and only then throw on `o.stats.waiting` — leaving consumers
        // with a non-null overview whose `stats` is undefined (a render crash).
        const st = o?.stats;
        const tp = o?.throughput;
        if (!st || !tp) throw new Error('malformed /dashboard body');
        const depth = (st.waiting ?? 0) + (st.active ?? 0) + (st.delayed ?? 0);
        const p = tp.pushPerSec;
        const c = tp.completePerSec;
        const f = tp.failPerSec;
        // Skipped ticks (hidden tab, in-flight, errors) leave no hole in the
        // arrays, so a resumed series would silently span the gap while the
        // index→seconds axis (and depthTrend) still read it as 1 Hz. Restart
        // the window instead of stitching two eras together — but only after 4
        // intervals of slack: one skipped tick is ordinary jitter (a slow reply
        // makes the next tick find `inFlight` set), and resetting a 60-point
        // chart for that would leave it permanently stuck at a single point.
        const gap = lastSampleAt.current > 0 && tickAt - lastSampleAt.current > 4 * SAMPLE_MS;
        lastSampleAt.current = tickAt;
        setLatest(o);
        setError(null);
        setSeries((prev) => {
          const s = gap ? EMPTY_SERIES : prev;
          return {
            push: [...s.push, p].slice(-windowSize),
            complete: [...s.complete, c].slice(-windowSize),
            fail: [...s.fail, f].slice(-windowSize),
            depth: [...s.depth, depth].slice(-windowSize),
          };
        });
      } catch (e) {
        // Transient for the series (no point appended), but surfaced so a page
        // can tell "sampler is down" from "server is idle".
        if (mounted.current) setError(e as Error);
      } finally {
        inFlight.current = false;
      }
    };
    tick();
    const id = setInterval(tick, SAMPLE_MS);
    return () => {
      mounted.current = false;
      clearInterval(id);
    };
  }, [windowSize, baseUrl, token]);

  return { ...series, latest, error };
}

/**
 * Backlog trend from a depth series: the average per-second slope over the
 * window. Positive = accumulating (arriving faster than draining), negative =
 * draining. Returns { slope, label, draining }.
 *
 * `sampleMs` is the series' sampling period — the regression runs on array
 * indices, so a caller sampling at anything other than 1 Hz must say so or the
 * slope (and the ±0.05 jobs/sec dead band) is off by that factor.
 */
export function depthTrend(
  depth: number[],
  sampleMs = SAMPLE_MS
): {
  slope: number;
  label: string;
  draining: boolean;
} {
  if (depth.length < 2) return { slope: 0, label: 'steady', draining: false };
  // Least-squares slope over the sampled points, rescaled to per-second.
  const n = depth.length;
  const xMean = (n - 1) / 2;
  const yMean = depth.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (depth[i] - yMean);
    den += (i - xMean) ** 2;
  }
  const perSample = den === 0 ? 0 : num / den;
  const slope = sampleMs > 0 ? perSample * (SAMPLE_MS / sampleMs) : perSample;
  const draining = slope < -0.05;
  const label = draining ? 'draining' : slope > 0.05 ? 'accumulating' : 'steady';
  return { slope, label, draining };
}
