import { useEffect, useRef, useState } from 'react';
import { bq, type ServerTargetClient } from '@/lib/bq';
import {
  benchmarkQueueError,
  clampInt,
  errMsg,
  LIMITS,
  makeJobs,
  type Phase,
  percentile,
  type RunConfig,
  type RunRecord,
  type Summary,
  sleepWhile,
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

const RUNNABLE_STATES = [
  'waiting',
  'prioritized',
  'delayed',
  'active',
  'paused',
  'waiting-children',
] as const;
export const BENCHMARK_QUEUE_STATES = [...RUNNABLE_STATES, 'completed', 'failed'] as const;

/** Jobs a simulated worker could consume now or while the run is in progress. */
export function runnableQueueJobs(counts: Record<string, number>): number {
  return RUNNABLE_STATES.reduce((total, state) => {
    const value = counts[state] ?? 0;
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Malformed queue count for "${state}".`);
    }
    return total + value;
  }, 0);
}

/** Exact v2.8.55 count envelope used by the dedicated-queue ownership preflight. */
export function benchmarkQueueJobs(counts: Record<string, number>): number {
  return BENCHMARK_QUEUE_STATES.reduce((total, state) => {
    const value = counts[state];
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
      throw new Error(`Malformed queue count for "${state}".`);
    }
    return total + (value as number);
  }, 0);
}

export function assertBenchmarkSuccess(
  response: unknown,
  action: string
): asserts response is { ok: true } & Record<string, unknown> {
  if (!response || typeof response !== 'object' || (response as { ok?: unknown }).ok !== true) {
    throw new Error(`${action} returned a malformed success response.`);
  }
}

/**
 * Drives a load test against the server: `producers` parallel loops bulk-push
 * jobs, and `workers` parallel loops pull → simulate processing → ack them, so
 * the queue genuinely fills and drains. All throughput is measured client-side;
 * everything is bounded by the configured caps, stoppable mid-run, and aborted
 * automatically if the page unmounts.
 */
export function useBenchmark() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [live, setLive] = useState<Live>(EMPTY_LIVE);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [history, setHistory] = useState<RunRecord[]>([]);
  // The exact config the current/last run was started with — progress bars and
  // labels derive from this, not from the still-editable form.
  const [runCfg, setRunCfg] = useState<RunConfig | null>(null);

  const stopRef = useRef(false);
  const mountedRef = useRef(true);
  const runGenerationRef = useRef(0);
  // Synchronous re-entry guard: phase state is async, so a double-click during
  // the preflight would otherwise start two engines over the same stats.
  const runningRef = useRef(false);
  const producersDone = useRef(false);
  const cfgRef = useRef<RunConfig | null>(null);
  const phaseRef = useRef<Phase>('idle');
  phaseRef.current = phase;
  const S = useRef<Stats>(freshStats());

  // Leaving the page must not leave the load running: the loops check stopRef
  // each iteration, so flipping it on unmount stops them like the Stop button.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopRef.current = true;
      runGenerationRef.current++;
    };
  }, []);

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
        if (phaseRef.current === 'draining') {
          // Smooth over bursty acks (a raw 200ms sample is often 0): average the
          // recent window, falling back to the cumulative rate.
          const recent = s.doneSeries.slice(-10);
          let rate = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : 0;
          if (rate <= 0 && elapsedMs > 0) rate = s.completed / (elapsedMs / 1000);
          if (rate > 0) etaMs = (Math.max(0, total - s.completed) / rate) * 1000;
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

  const run = async (config: RunConfig, pinnedClient?: ServerTargetClient) => {
    if (runningRef.current || !mountedRef.current) return;
    runningRef.current = true;
    const generation = ++runGenerationRef.current;
    const client = pinnedClient ?? bq.createServerTargetClient(bq.captureServerRequestTarget());
    const isCurrent = () => mountedRef.current && runGenerationRef.current === generation;
    const shouldContinue = () => isCurrent() && !stopRef.current;
    stopRef.current = false;

    try {
      // Clear any previous result immediately so an early error doesn't show a
      // stale "Result" card beside the error banner.
      setSummary(null);

      const queue = config.queue.trim();
      const queueError = benchmarkQueueError(queue);
      if (queueError) {
        setLive({ ...EMPTY_LIVE, error: queueError });
        phaseRef.current = 'error';
        setPhase('error');
        return;
      }

      if (!['count', 'duration'].includes(config.mode)) {
        setLive({ ...EMPTY_LIVE, error: 'Benchmark mode is invalid.' });
        phaseRef.current = 'error';
        setPhase('error');
        return;
      }
      if (typeof config.durable !== 'boolean' || typeof config.removeOnComplete !== 'boolean') {
        setLive({ ...EMPTY_LIVE, error: 'Benchmark job options are invalid.' });
        phaseRef.current = 'error';
        setPhase('error');
        return;
      }

      const total = clampInt(config.total, 1, LIMITS.total);
      const durationS = clampInt(config.durationS, 1, LIMITS.durationS);
      const durationMs = durationS * 1000;
      const batch = clampInt(config.batch, 1, LIMITS.batch);
      const producers = clampInt(config.producers, 1, LIMITS.producers);
      const payload = clampInt(config.payload, 0, LIMITS.payload);
      const workers = clampInt(config.workers, 0, LIMITS.workers);
      const workerBatch = clampInt(config.workerBatch, 1, LIMITS.workerBatch);
      const processMs = clampInt(config.processMs, 0, LIMITS.processMs);
      const runConfig: RunConfig = Object.freeze({
        ...config,
        queue,
        total,
        durationS,
        batch,
        producers,
        payload,
        workers,
        workerBatch,
        processMs,
      });
      // Preflight: fail fast + clearly if the pinned server isn't reachable.
      try {
        assertBenchmarkSuccess(await client.overview(), 'Dashboard preflight');
      } catch (e) {
        if (!isCurrent()) return;
        setLive({
          ...EMPTY_LIVE,
          error: `Server unreachable — start it on the Server page first. (${errMsg(e)})`,
        });
        setPhase('error');
        return;
      }
      if (!shouldContinue()) return;

      // Ownership boundary: every benchmark starts from a completely empty
      // dedicated queue, including terminal and flow-parent states. Checking
      // only runnable jobs would let a later queue-wide cleanup delete retained
      // production history or waiting-children records.
      try {
        const current = await client.counts(queue);
        if (!shouldContinue()) return;
        assertBenchmarkSuccess(current, 'Queue-count preflight');
        if (
          !current?.counts ||
          typeof current.counts !== 'object' ||
          Array.isArray(current.counts)
        ) {
          throw new Error('Malformed queue-count response.');
        }
        const existing = benchmarkQueueJobs(current.counts);
        if (existing > 0) {
          setLive({
            ...EMPTY_LIVE,
            error: `Dedicated benchmark queue "${queue}" is not empty (${existing} job(s) across all states). Clean it before running so no external work can be consumed or deleted.`,
          });
          setPhase('error');
          return;
        }
      } catch (e) {
        if (!isCurrent()) return;
        setLive({
          ...EMPTY_LIVE,
          error: `Could not verify that dedicated queue "${queue}" is empty. (${errMsg(e)})`,
        });
        setPhase('error');
        return;
      }
      if (!shouldContinue()) return;

      producersDone.current = false;
      cfgRef.current = runConfig;
      setRunCfg(runConfig);
      S.current = freshStats();
      S.current.startedAt = performance.now();
      S.current.lastAt = performance.now();
      setLive({ ...EMPTY_LIVE });
      phaseRef.current = 'running';
      setPhase('running');

      const blob = 'x'.repeat(payload);
      const deadline = performance.now() + durationMs;
      const runId = `bqbench-${globalThis.crypto.randomUUID()}`;
      const ownJobIds = new Set<string>();
      const pendingPushes = new Set<Promise<void>>();

      const produce = async () => {
        while (shouldContinue()) {
          let size: number;
          if (runConfig.mode === 'count') {
            if (S.current.assigned >= total) break;
            size = Math.min(batch, total - S.current.assigned);
          } else {
            if (performance.now() >= deadline) break;
            size = batch;
          }
          const base = S.current.assigned;
          S.current.assigned += size;
          const jobs = makeJobs(
            base,
            size,
            blob,
            runConfig.durable,
            runConfig.removeOnComplete,
            runId,
            Math.max(120_000, processMs + 60_000)
          );
          const t0 = performance.now();
          const request = client
            .addJobsBulk(queue, jobs)
            .then((response) => {
              if (!isCurrent()) return;
              assertBenchmarkSuccess(response, 'Bulk enqueue');
              if (
                !Array.isArray(response.ids) ||
                response.ids.length !== size ||
                response.ids.some((id) => typeof id !== 'string' || id.length === 0) ||
                new Set(response.ids).size !== response.ids.length
              ) {
                throw new Error('Bulk enqueue returned invalid job IDs.');
              }
              const ids = response.ids as string[];
              for (const id of ids) ownJobIds.add(id);
              S.current.pushed += ids.length;
              S.current.bytes += ids.length * payload;
              const shortfall = Math.max(0, size - ids.length);
              if (shortfall > 0) {
                S.current.pushFailed += shortfall;
                S.current.error ??= `Server created ${ids.length} of ${size} jobs in a benchmark batch.`;
              }
            })
            .catch((e) => {
              if (!isCurrent()) return;
              S.current.pushFailed += size;
              S.current.error ??= errMsg(e);
            });
          pendingPushes.add(request);
          try {
            await request;
          } finally {
            pendingPushes.delete(request);
          }
          if (isCurrent()) S.current.pushLat.push(performance.now() - t0);
        }
      };

      const consume = async () => {
        while (shouldContinue()) {
          if (runConfig.mode === 'duration' && performance.now() >= deadline) break;
          if (runConfig.mode === 'count' && S.current.completed >= total) break;
          // The active-workers gauge spans the whole pull → process → ack cycle
          // (not just the simulated sleep), so it reads truthfully at processMs=0.
          S.current.activeWorkers++;
          let jobs: { id: string }[] = [];
          try {
            try {
              const response = await client.pullBatch(queue, workerBatch);
              if (!shouldContinue()) break;
              if (
                response?.ok !== true ||
                !Array.isArray(response?.jobs) ||
                response.jobs.length > workerBatch ||
                response.jobs.some(
                  (job) =>
                    !job ||
                    typeof job !== 'object' ||
                    typeof job.id !== 'string' ||
                    job.id.length === 0
                ) ||
                new Set(response.jobs.map((job) => job.id)).size !== response.jobs.length
              ) {
                throw new Error('Malformed pull-batch response.');
              }
              jobs = response.jobs;
            } catch (e) {
              if (!isCurrent()) break;
              S.current.error ??= errMsg(e);
            }
            if (!shouldContinue()) break;
            if (jobs.length > 0) {
              // A pull may beat the HTTP response that contains its generated
              // ids. Wait only when an id is not known yet, then classify it
              // against every producer request that was in flight.
              if (jobs.some((job) => !ownJobIds.has(job.id)) && pendingPushes.size > 0) {
                await Promise.allSettled([...pendingPushes]);
              }
              // Stop/unmount may happen during the producer wait. In that case
              // issue no ACK or retry; the server's stall timeout safely releases
              // reservations made by the already-issued pull.
              if (!shouldContinue()) break;

              const own = jobs.filter((job) => ownJobIds.has(job.id));
              const foreign = jobs.filter((job) => !ownJobIds.has(job.id));
              if (foreign.length > 0) {
                // Do not ACK external work. Move it back to waiting and stop the
                // run: continuing could repeatedly reserve another producer's
                // jobs and perturb a live queue even if accounting stayed exact.
                if (!shouldContinue()) break;
                const restored = await Promise.allSettled(
                  foreign.map(async (job) => {
                    const response = await client.retryJob(job.id);
                    assertBenchmarkSuccess(response, `Restore job ${job.id}`);
                  })
                );
                if (!isCurrent()) break;
                const restoreFailures = restored.filter((result) => result.status === 'rejected');
                S.current.error ??=
                  restoreFailures.length > 0
                    ? `Detected ${foreign.length} foreign job(s); ${restoreFailures.length} could not be returned to waiting. Benchmark stopped.`
                    : `Detected ${foreign.length} foreign job(s); returned them to waiting and stopped without counting them.`;
                stopRef.current = true;
              }
              // Abortable: Stop cuts the simulated processing short and the
              // post-sleep gate guarantees it cannot be followed by an ACK.
              if (own.length > 0 && shouldContinue()) {
                if (processMs > 0) await sleepWhile(processMs, shouldContinue);
                if (!shouldContinue()) break;
                try {
                  // ACKB intentionally skips ids no longer in processing while
                  // still returning ok:true. Refresh and verify every active
                  // lease first so a background-tab stall can never be counted
                  // as completed after the broker requeued/DLQed it.
                  const heartbeat = await client.heartbeatBatch(own.map((job) => job.id));
                  assertBenchmarkSuccess(heartbeat, 'Heartbeat benchmark jobs');
                  const heartbeatData = heartbeat.data;
                  if (
                    !heartbeatData ||
                    typeof heartbeatData !== 'object' ||
                    heartbeatData.ok !== true ||
                    !Number.isSafeInteger(heartbeatData.count) ||
                    heartbeatData.count !== own.length
                  ) {
                    throw new Error(
                      `Heartbeat confirmed ${String(heartbeatData?.count)} of ${own.length} benchmark jobs; refusing a lossy batch ACK.`
                    );
                  }
                  if (!shouldContinue()) break;
                  const response = await client.ackBatch(own.map((job) => job.id));
                  assertBenchmarkSuccess(response, 'Acknowledge benchmark jobs');
                  if (!isCurrent()) break;
                  S.current.completed += own.length;
                  for (const job of own) ownJobIds.delete(job.id);
                } catch (e) {
                  if (!isCurrent()) break;
                  S.current.ackFailed += own.length;
                  S.current.error ??= errMsg(e);
                }
              }
            }
          } finally {
            if (isCurrent()) S.current.activeWorkers--;
          }
          if (!shouldContinue()) break;
          if (jobs.length === 0) {
            if (runConfig.mode === 'count' && producersDone.current) {
              if (ownJobIds.size > 0) {
                S.current.error ??= `${ownJobIds.size} benchmark job(s) could not be drained.`;
              }
              break;
            }
            await sleepWhile(50, shouldContinue);
          }
        }
      };

      const producerLoops = Array.from({ length: producers }, produce);
      const consumerLoops = Array.from({ length: workers }, consume);
      const producersAll = Promise.all(producerLoops).then(() => {
        if (!isCurrent()) return;
        producersDone.current = true;
        if (
          shouldContinue() &&
          runConfig.mode === 'count' &&
          workers > 0 &&
          phaseRef.current === 'running'
        ) {
          phaseRef.current = 'draining';
          setPhase('draining');
        }
      });
      await Promise.all([producersAll, ...consumerLoops]);
      if (!isCurrent()) return;

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
        pushFailed: s.pushFailed,
        ackFailed: s.ackFailed,
        bytes: s.bytes,
        elapsedMs: durationMsActual,
        // Instantaneous rates are over once the run ends — zero them so the
        // cards and the chart legend agree instead of freezing a stale sample.
        pushPerSec: 0,
        donePerSec: 0,
        activeWorkers: 0,
        etaMs: 0,
        error: s.error,
      }));
      setHistory((h) =>
        [
          { ...sum, id: ++recordId, at: Date.now(), mode: runConfig.mode, producers, workers },
          ...h,
        ].slice(0, 12)
      );
      phaseRef.current = stopRef.current ? 'stopped' : s.error ? 'error' : 'done';
      setPhase(phaseRef.current);
    } finally {
      runningRef.current = false;
    }
  };

  const stop = () => {
    stopRef.current = true;
    // Acknowledge immediately: loops may take a moment to settle in-flight work.
    if (phaseRef.current === 'running' || phaseRef.current === 'draining') {
      phaseRef.current = 'stopping';
      setPhase('stopping');
    }
  };
  const reset = () => {
    stopRef.current = true;
    runGenerationRef.current++;
    phaseRef.current = 'idle';
    setSummary(null);
    setLive(EMPTY_LIVE);
    setPhase('idle');
  };
  const clearHistory = () => setHistory([]);

  return { phase, live, summary, history, runCfg, run, stop, reset, clearHistory };
}
