import { useEffect, useRef, useState } from 'react';
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
}

export function useThroughputSeries(windowSize = 60): ThroughputData {
  const [series, setSeries] = useState<ThroughputSeries>({
    push: [],
    complete: [],
    fail: [],
    depth: [],
  });
  const [latest, setLatest] = useState<Overview | null>(null);
  const mounted = useRef(true);
  const inFlight = useRef(false);

  useEffect(() => {
    mounted.current = true;
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
      try {
        const o = await bq.overview();
        if (!mounted.current) return;
        setLatest(o);
        const depth = (o.stats.waiting ?? 0) + (o.stats.active ?? 0) + (o.stats.delayed ?? 0);
        setSeries((s) => ({
          push: [...s.push, o.throughput.pushPerSec].slice(-windowSize),
          complete: [...s.complete, o.throughput.completePerSec].slice(-windowSize),
          fail: [...s.fail, o.throughput.failPerSec].slice(-windowSize),
          depth: [...s.depth, depth].slice(-windowSize),
        }));
      } catch {
        /* transient */
      } finally {
        inFlight.current = false;
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => {
      mounted.current = false;
      clearInterval(id);
    };
  }, [windowSize]);

  return { ...series, latest };
}

/**
 * Backlog trend from a depth series: the average per-second slope over the
 * window. Positive = accumulating (arriving faster than draining), negative =
 * draining. Returns { slope, label, draining }.
 */
export function depthTrend(depth: number[]): {
  slope: number;
  label: string;
  draining: boolean;
} {
  if (depth.length < 2) return { slope: 0, label: 'steady', draining: false };
  // Least-squares slope over the sampled points (1 sample/sec ⇒ per-second).
  const n = depth.length;
  const xMean = (n - 1) / 2;
  const yMean = depth.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (depth[i] - yMean);
    den += (i - xMean) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  const draining = slope < -0.05;
  const label = draining ? 'draining' : slope > 0.05 ? 'accumulating' : 'steady';
  return { slope, label, draining };
}
