import type { ServerTargetClient } from '@/lib/bq';
import { benchmarkQueueError, clampInt, errMsg, LIMITS, type RunConfig } from './engine';
import { assertBenchmarkSuccess, benchmarkQueueJobs } from './queueValidation';
import { EMPTY_LIVE, type Live } from './runtimeState';

export function normalizeRunConfig(
  config: RunConfig
): { ok: true; config: RunConfig } | { ok: false; error: string } {
  const queue = config.queue.trim();
  const queueError = benchmarkQueueError(queue);
  if (queueError) return { ok: false, error: queueError };
  if (!['count', 'duration'].includes(config.mode)) {
    return { ok: false, error: 'Benchmark mode is invalid.' };
  }
  if (typeof config.durable !== 'boolean' || typeof config.removeOnComplete !== 'boolean') {
    return { ok: false, error: 'Benchmark job options are invalid.' };
  }
  return {
    ok: true,
    config: Object.freeze({
      ...config,
      queue,
      total: clampInt(config.total, 1, LIMITS.total),
      durationS: clampInt(config.durationS, 1, LIMITS.durationS),
      batch: clampInt(config.batch, 1, LIMITS.batch),
      producers: clampInt(config.producers, 1, LIMITS.producers),
      payload: clampInt(config.payload, 0, LIMITS.payload),
      workers: clampInt(config.workers, 0, LIMITS.workers),
      workerBatch: clampInt(config.workerBatch, 1, LIMITS.workerBatch),
      processMs: clampInt(config.processMs, 0, LIMITS.processMs),
    }),
  };
}

export async function preflightBenchmark(
  client: ServerTargetClient,
  queue: string,
  shouldContinue: () => boolean
): Promise<{ ok: true } | { ok: false; live: Live }> {
  try {
    assertBenchmarkSuccess(await client.overview(), 'Dashboard preflight');
  } catch (error) {
    return {
      ok: false,
      live: {
        ...EMPTY_LIVE,
        error: `Server unreachable — start it on the Server page first. (${errMsg(error)})`,
      },
    };
  }
  if (!shouldContinue()) return { ok: true };

  try {
    const current = await client.counts(queue);
    if (!shouldContinue()) return { ok: true };
    assertBenchmarkSuccess(current, 'Queue-count preflight');
    if (!current.counts || typeof current.counts !== 'object' || Array.isArray(current.counts)) {
      throw new Error('Malformed queue-count response.');
    }
    const existing = benchmarkQueueJobs(current.counts);
    if (existing > 0) {
      return {
        ok: false,
        live: {
          ...EMPTY_LIVE,
          error: `Dedicated benchmark queue "${queue}" is not empty (${existing} job(s) across all states). Clean it before running so no external work can be consumed or deleted.`,
        },
      };
    }
  } catch (error) {
    return {
      ok: false,
      live: {
        ...EMPTY_LIVE,
        error: `Could not verify that dedicated queue "${queue}" is empty. (${errMsg(error)})`,
      },
    };
  }
  return { ok: true };
}
