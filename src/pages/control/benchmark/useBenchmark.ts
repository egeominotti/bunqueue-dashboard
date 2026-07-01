import { useEffect, useRef, useState } from 'react';
import { bq } from '@/lib/bq';
import {
  clampInt,
  errMsg,
  LIMITS,
  makeJobs,
  type Phase,
  percentile,
  type RunConfig,
  type RunRecord,
  type Summary,
  sleep,
} from './engine';

export interface Live {
  pushed: number;
  completed: number;
  pushFailed: number;
  ackFailed: number;
  bytes: number;
  elapsedMs: number;
  pushPerSec: number;
  donePerSec: number;
  activeWorkers: number;
  pushSeries: number[];
  doneSeries: number[];
  etaMs: number | null;
  error: string | null;
}

const EMPTY_LIVE: Live = {
  pushed: 0,
  completed: 0,
  pushFailed: 0,
  ackFailed: 0,
  bytes: 0,
  elapsedMs: 0,
  pushPerSec: 0,
  donePerSec: 0,
  activeWorkers: 0,
  pushSeries: [],
  doneSeries: [],
  etaMs: null,
  error: null,
};

interface Stats {
  pushed: number;
  completed: number;
  pushFailed: number;
  ackFailed: number;
  bytes: number;
  assigned: number;
  startedAt: number;
  pushLat: number[];
  activeWorkers: number;
  error: string | null;
  lastAt: number;
  lastPushed: number;
  lastDone: number;
  pushSeries: number[];
  doneSeries: number[];
}

const freshStats = (): Stats => ({
  pushed: 0,
  completed: 0,
  pushFailed: 0,
  ackFailed: 0,
  bytes: 0,
  assigned: 0,
  startedAt: 0,
  pushLat: [],
  activeWorkers: 0,
  error: null,
  lastAt: 0,
  lastPushed: 0,
  lastDone: 0,
  pushSeries: [],
  doneSeries: [],
});

let recordId = 0;

/**
 * Drives a load test against the server: `producers` parallel loops bulk-push
 * jobs, and `workers` parallel loops pull → simulate processing → ack them, so
 * the queue genuinely fills and drains. All throughput is measured client-side;
 * everything is bounded by the configured caps and stoppable.
 */
export function useBenchmark() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [live, setLive] = useState<Live>(EMPTY_LIVE);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [history, setHistory] = useState<RunRecord[]>([]);

  const stopRef = useRef(false);
  const producersDone = useRef(false);
  const cfgRef = useRef<RunConfig | null>(null);
  const phaseRef = useRef<Phase>('idle');
  phaseRef.current = phase;
  const S = useRef<Stats>(freshStats());

  // Sample counters + per-second series into state ~5x/sec while active.
  useEffect(() => {
    if (phase !== 'running' && phase !== 'draining') return;
    const id = setInterval(() => {
      const s = S.current;
      const now = performance.now();
      const elapsedMs = now - s.startedAt;
      const dt = (now - s.lastAt) / 1000;
      const pushInst = dt > 0 ? Math.max(0, (s.pushed - s.lastPushed) / dt) : 0;
      const doneInst = dt > 0 ? Math.max(0, (s.completed - s.lastDone) / dt) : 0;
      s.lastAt = now;
      s.lastPushed = s.pushed;
      s.lastDone = s.completed;
      s.pushSeries = [...s.pushSeries, pushInst].slice(-60);
      s.doneSeries = [...s.doneSeries, doneInst].slice(-60);

      let etaMs: number | null = null;
      const cfg = cfgRef.current;
      if (cfg && cfg.mode === 'count') {
        const total = clampInt(cfg.total, 1, LIMITS.total);
        if (phaseRef.current === 'draining' && doneInst > 0) {
          etaMs = (Math.max(0, total - s.completed) / doneInst) * 1000;
        } else if (pushInst > 0) {
          etaMs = (Math.max(0, total - s.pushed) / pushInst) * 1000;
        }
      } else if (cfg && cfg.mode === 'duration') {
        etaMs = Math.max(0, clampInt(cfg.durationS, 1, LIMITS.durationS) * 1000 - elapsedMs);
      }

      setLive({
        pushed: s.pushed,
        completed: s.completed,
        pushFailed: s.pushFailed,
        ackFailed: s.ackFailed,
        bytes: s.bytes,
        elapsedMs,
        pushPerSec: pushInst,
        donePerSec: doneInst,
        activeWorkers: s.activeWorkers,
        pushSeries: s.pushSeries,
        doneSeries: s.doneSeries,
        etaMs,
        error: s.error,
      });
    }, 200);
    return () => clearInterval(id);
  }, [phase]);

  const run = async (config: RunConfig) => {
    const queue = config.queue.trim();
    if (!queue) {
      setLive({ ...EMPTY_LIVE, error: 'Queue name is required.' });
      setPhase('error');
      return;
    }

    // Preflight: fail fast + clearly if the server isn't reachable.
    try {
      await bq.overview();
    } catch (e) {
      setLive({
        ...EMPTY_LIVE,
        error: `Server unreachable — start it on the Server page first. (${errMsg(e)})`,
      });
      setPhase('error');
      return;
    }

    const total = clampInt(config.total, 1, LIMITS.total);
    const durationMs = clampInt(config.durationS, 1, LIMITS.durationS) * 1000;
    const batch = clampInt(config.batch, 1, LIMITS.batch);
    const producers = clampInt(
      config.producers,
      config.mode === 'duration' ? 0 : 1,
      LIMITS.producers
    );
    const payload = clampInt(config.payload, 0, LIMITS.payload);
    const workers = clampInt(config.workers, 0, LIMITS.workers);
    const workerBatch = clampInt(config.workerBatch, 1, LIMITS.workerBatch);
    const processMs = clampInt(config.processMs, 0, LIMITS.processMs);

    stopRef.current = false;
    producersDone.current = false;
    cfgRef.current = config;
    S.current = freshStats();
    S.current.startedAt = performance.now();
    S.current.lastAt = performance.now();
    setSummary(null);
    setLive({ ...EMPTY_LIVE });
    setPhase('running');

    const blob = 'x'.repeat(payload);
    const deadline = performance.now() + durationMs;

    const produce = async () => {
      while (!stopRef.current) {
        let size: number;
        if (config.mode === 'count') {
          if (S.current.assigned >= total) break;
          size = Math.min(batch, total - S.current.assigned);
        } else {
          if (performance.now() >= deadline) break;
          size = batch;
        }
        const base = S.current.assigned;
        S.current.assigned += size;
        const jobs = makeJobs(base, size, blob, config.durable, config.removeOnComplete);
        const t0 = performance.now();
        try {
          await bq.addJobsBulk(queue, jobs);
          S.current.pushed += size;
          S.current.bytes += size * payload;
        } catch (e) {
          S.current.pushFailed += size;
          S.current.error ??= errMsg(e);
        }
        S.current.pushLat.push(performance.now() - t0);
      }
    };

    const consume = async () => {
      while (!stopRef.current) {
        if (config.mode === 'duration' && performance.now() >= deadline) break;
        if (config.mode === 'count' && S.current.completed >= total) break;
        let jobs: { id: string }[];
        try {
          const r = await bq.pullBatch(queue, workerBatch);
          jobs = r.jobs ?? [];
        } catch (e) {
          S.current.error ??= errMsg(e);
          jobs = [];
        }
        if (jobs.length === 0) {
          if (config.mode === 'count' && producersDone.current) break;
          await sleep(50);
          continue;
        }
        S.current.activeWorkers++;
        if (processMs > 0) await sleep(processMs);
        S.current.activeWorkers--;
        try {
          await bq.ackBatch(jobs.map((j) => j.id));
          S.current.completed += jobs.length;
        } catch (e) {
          S.current.ackFailed += jobs.length;
          S.current.error ??= errMsg(e);
        }
      }
    };

    const producerLoops = Array.from({ length: producers }, produce);
    const consumerLoops = Array.from({ length: workers }, consume);
    const producersAll = Promise.all(producerLoops).then(() => {
      producersDone.current = true;
      if (
        !stopRef.current &&
        config.mode === 'count' &&
        workers > 0 &&
        phaseRef.current === 'running'
      ) {
        setPhase('draining');
      }
    });
    await Promise.all([producersAll, ...consumerLoops]);

    const s = S.current;
    const durationMsActual = performance.now() - s.startedAt;
    const secs = durationMsActual / 1000 || 1;
    const sorted = [...s.pushLat].sort((a, b) => a - b);
    const sum: Summary = {
      pushed: s.pushed,
      completed: s.completed,
      pushFailed: s.pushFailed,
      ackFailed: s.ackFailed,
      bytes: s.bytes,
      durationMs: durationMsActual,
      pushPerSec: s.pushed / secs,
      donePerSec: s.completed / secs,
      mbPerSec: s.bytes / secs,
      avg: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      max: sorted.length ? sorted[sorted.length - 1] : 0,
      error: s.error,
    };
    setSummary(sum);
    setLive((l) => ({
      ...l,
      pushed: s.pushed,
      completed: s.completed,
      elapsedMs: durationMsActual,
      activeWorkers: 0,
      etaMs: 0,
    }));
    setHistory((h) =>
      [
        { ...sum, id: ++recordId, at: Date.now(), mode: config.mode, producers, workers },
        ...h,
      ].slice(0, 12)
    );
    setPhase(stopRef.current ? 'stopped' : 'done');
  };

  const stop = () => {
    stopRef.current = true;
  };
  const reset = () => {
    stopRef.current = true;
    setSummary(null);
    setLive(EMPTY_LIVE);
    setPhase('idle');
  };
  const clearHistory = () => setHistory([]);

  return { phase, live, summary, history, run, stop, reset, clearHistory };
}
