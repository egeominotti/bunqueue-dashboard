import { useEffect, useRef, useState } from 'react';
import { bq } from '@/lib/bq';
import { formatNumber } from '@/lib/format';
import { benchmarkQueueError, isDashboardBenchmarkQueue, LIMITS } from './engine';
import {
  type BenchmarkDraft,
  CLEAN_STATES,
  type PinnedBenchmarkTarget,
  toBenchmarkConfig,
} from './pageModel';
import { assertBenchmarkSuccess, benchmarkQueueJobs, type useBenchmark } from './useBenchmark';

type QueueCounts = Record<string, number>;

interface OperationsInput {
  benchmark: ReturnType<typeof useBenchmark>;
  counts: QueueCounts | null;
  dedicatedQueue: string;
  draft: BenchmarkDraft;
  pollQueue: string;
  runTarget: PinnedBenchmarkTarget | null;
  setRunTarget: (target: PinnedBenchmarkTarget) => void;
}

export function useBenchmarkOperations({
  benchmark,
  counts,
  dedicatedQueue,
  draft,
  pollQueue,
  runTarget,
  setRunTarget,
}: OperationsInput) {
  const operationRef = useRef<'run' | 'clean' | null>(null);
  const mountedRef = useRef(true);
  const [cleaning, setCleaning] = useState(false);
  const [cleanResult, setCleanResult] = useState<{ remaining: number } | { error: string } | null>(
    null
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      operationRef.current = null;
    };
  }, []);

  const cleanup = async () => {
    const queue = draft.queue.trim();
    if (operationRef.current || !queue) return;
    if (!isDashboardBenchmarkQueue(queue) || queue !== dedicatedQueue) {
      setCleanResult({ error: 'refusing to clean a queue not owned by this dashboard session' });
      return;
    }

    operationRef.current = 'clean';
    const pinned = runTarget ?? captureTarget();
    const countNote =
      counts && pollQueue === queue
        ? ` Currently ${formatNumber(counts.waiting ?? 0)} waiting / ${formatNumber(counts.completed ?? 0)} completed.`
        : '';
    if (
      !window.confirm(
        `Clean every cleanable job from the dedicated dashboard benchmark queue "${queue}" on ${pinned.target.baseUrl}? This is queue-wide; the cryptographic queue name is owned by this browser session.${countNote}`
      )
    ) {
      operationRef.current = null;
      return;
    }

    setCleaning(true);
    setCleanResult(null);
    try {
      let lastError: string | null = null;
      for (const state of CLEAN_STATES) {
        if (!mountedRef.current) return;
        try {
          const response = await pinned.client.clean(queue, { state, limit: LIMITS.total });
          assertBenchmarkSuccess(response, `Clean ${state} jobs`);
          if (!Number.isSafeInteger(response.count) || (response.count as number) < 0) {
            throw new Error(`Clean ${state} jobs returned an invalid count.`);
          }
        } catch (error) {
          lastError = (error as Error).message;
        }
      }

      if (!mountedRef.current) return;
      const response = await pinned.client.counts(queue).catch((error) => {
        lastError = (error as Error).message;
        return null;
      });
      if (!mountedRef.current) return;

      if (!response) {
        setCleanResult({ error: lastError ?? 'server unreachable — could not verify' });
      } else if (
        response.ok !== true ||
        !response.counts ||
        typeof response.counts !== 'object' ||
        Array.isArray(response.counts)
      ) {
        setCleanResult({ error: 'server returned a malformed queue-count response' });
      } else {
        try {
          const remaining = benchmarkQueueJobs(response.counts);
          setCleanResult(
            lastError || remaining > 0
              ? { error: lastError ?? `${formatNumber(remaining)} job(s) still present` }
              : { remaining: 0 }
          );
        } catch {
          setCleanResult({ error: 'server returned malformed queue counts' });
        }
      }
    } finally {
      if (mountedRef.current) setCleaning(false);
      if (operationRef.current === 'clean') operationRef.current = null;
    }
  };

  const start = () => {
    if (operationRef.current) return;
    operationRef.current = 'run';
    const config = toBenchmarkConfig(draft);
    const queue = config.queue.trim();
    const pinned = captureTarget();

    if (benchmarkQueueError(queue)) {
      void benchmark.run({ ...config, queue }, pinned.client).finally(releaseRun);
      return;
    }

    let existingJobs = 0;
    if (!runTarget && counts && pollQueue === queue) {
      try {
        existingJobs = benchmarkQueueJobs(counts);
      } catch {
        // The benchmark engine validates a fresh count response before running.
      }
    }
    const warning =
      existingJobs > 0
        ? ` Warning: it already holds ${formatNumber(existingJobs)} job(s) across all states; the safety preflight will refuse the run until the dedicated queue is empty.`
        : '';
    if (
      !window.confirm(`Enqueue real jobs into "${queue}" on ${pinned.target.baseUrl}?${warning}`)
    ) {
      operationRef.current = null;
      return;
    }

    setRunTarget(pinned);
    void benchmark.run(config, pinned.client).finally(releaseRun);
  };

  const releaseRun = () => {
    if (operationRef.current === 'run') operationRef.current = null;
  };

  return { cleaning, cleanResult, cleanup, start };
}

function captureTarget(): PinnedBenchmarkTarget {
  const target = bq.captureServerRequestTarget();
  return { target, client: bq.createServerTargetClient(target) };
}
