import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { bq, type ServerTargetClient } from '@/lib/bq';
import { createBenchmarkCompensationQueue } from './compensationQueue';
import type { Phase, RunConfig, RunRecord, Summary } from './engine';
import { normalizeRunConfig, preflightBenchmark } from './prepareRun';
import { type BenchmarkLoopContext, createConsumer, createProducer } from './runLoops';
import {
  type BenchmarkStats,
  EMPTY_LIVE,
  freshBenchmarkStats,
  type Live,
  summarizeRun,
} from './runtimeState';

interface BenchmarkRuntime {
  configRef: MutableRefObject<RunConfig | null>;
  mountedRef: MutableRefObject<boolean>;
  phaseRef: MutableRefObject<Phase>;
  producersDoneRef: MutableRefObject<boolean>;
  runningRef: MutableRefObject<boolean>;
  runGenerationRef: MutableRefObject<number>;
  setHistory: Dispatch<SetStateAction<RunRecord[]>>;
  setLive: Dispatch<SetStateAction<Live>>;
  setPhase: Dispatch<SetStateAction<Phase>>;
  setRunConfig: Dispatch<SetStateAction<RunConfig | null>>;
  setSummary: Dispatch<SetStateAction<Summary | null>>;
  statsRef: MutableRefObject<BenchmarkStats>;
  stopRef: MutableRefObject<boolean>;
}

let recordId = 0;

export async function runBenchmark(
  runtime: BenchmarkRuntime,
  input: RunConfig,
  pinnedClient?: ServerTargetClient
) {
  if (runtime.runningRef.current || !runtime.mountedRef.current) return;
  runtime.runningRef.current = true;
  const generation = ++runtime.runGenerationRef.current;
  const client = pinnedClient ?? bq.createServerTargetClient(bq.captureServerRequestTarget());
  const isCurrent = () =>
    runtime.mountedRef.current && runtime.runGenerationRef.current === generation;
  const shouldContinue = () => isCurrent() && !runtime.stopRef.current;
  runtime.stopRef.current = false;

  try {
    runtime.setSummary(null);
    const normalized = normalizeRunConfig(input);
    if (!normalized.ok) {
      runtime.setLive({ ...EMPTY_LIVE, error: normalized.error });
      setRuntimePhase(runtime, 'error');
      return;
    }
    const config = normalized.config;
    const preflight = await preflightBenchmark(client, config.queue, shouldContinue);
    if (!isCurrent()) return;
    if (!preflight.ok) {
      runtime.setLive(preflight.live);
      setRuntimePhase(runtime, 'error');
      return;
    }
    if (!shouldContinue()) return;

    runtime.producersDoneRef.current = false;
    runtime.configRef.current = config;
    runtime.setRunConfig(config);
    const stats = freshBenchmarkStats();
    stats.startedAt = performance.now();
    stats.lastAt = performance.now();
    runtime.statsRef.current = stats;
    runtime.setLive({ ...EMPTY_LIVE });
    setRuntimePhase(runtime, 'running');

    const context: BenchmarkLoopContext = {
      batch: config.batch,
      blob: 'x'.repeat(config.payload),
      client,
      compensationQueue: createBenchmarkCompensationQueue(),
      deadline: performance.now() + config.durationS * 1000,
      isCurrent,
      ownJobIds: new Set<string>(),
      payload: config.payload,
      pendingPushes: new Set<Promise<void>>(),
      processMs: config.processMs,
      producersDone: () => runtime.producersDoneRef.current,
      queue: config.queue,
      runConfig: config,
      runId: `bqbench-${globalThis.crypto.randomUUID()}`,
      shouldContinue,
      stats,
      stop: () => {
        runtime.stopRef.current = true;
      },
      total: config.total,
      workerBatch: config.workerBatch,
    };

    const producer = createProducer(context);
    const consumer = createConsumer(context);
    const producerLoops = Array.from({ length: config.producers }, producer);
    const consumerLoops = Array.from({ length: config.workers }, consumer);
    const producersAll = Promise.all(producerLoops).then(() => {
      if (!isCurrent()) return;
      runtime.producersDoneRef.current = true;
      if (
        shouldContinue() &&
        config.mode === 'count' &&
        config.workers > 0 &&
        runtime.phaseRef.current === 'running'
      ) {
        setRuntimePhase(runtime, 'draining');
      }
    });
    await Promise.all([producersAll, ...consumerLoops]);
    if (!isCurrent()) return;
    finishRun(runtime, config, stats);
  } finally {
    runtime.runningRef.current = false;
  }
}

function finishRun(runtime: BenchmarkRuntime, config: RunConfig, stats: BenchmarkStats) {
  const durationMs = performance.now() - stats.startedAt;
  const summary = summarizeRun(stats, durationMs);
  runtime.setSummary(summary);
  runtime.setLive((current) => ({
    ...current,
    pushed: stats.pushed,
    completed: stats.completed,
    pushFailed: stats.pushFailed,
    ackFailed: stats.ackFailed,
    bytes: stats.bytes,
    elapsedMs: durationMs,
    pushPerSec: 0,
    donePerSec: 0,
    activeWorkers: 0,
    etaMs: 0,
    error: stats.error,
  }));
  runtime.setHistory((history) =>
    [
      {
        ...summary,
        id: ++recordId,
        at: Date.now(),
        mode: config.mode,
        producers: config.producers,
        workers: config.workers,
      },
      ...history,
    ].slice(0, 12)
  );
  setRuntimePhase(runtime, runtime.stopRef.current ? 'stopped' : stats.error ? 'error' : 'done');
}

function setRuntimePhase(runtime: BenchmarkRuntime, phase: Phase) {
  runtime.phaseRef.current = phase;
  runtime.setPhase(phase);
}
