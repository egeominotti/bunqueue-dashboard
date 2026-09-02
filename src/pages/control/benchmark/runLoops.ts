import type { ServerTargetClient } from '@/lib/bq';
import type { BenchmarkCompensationQueue } from './compensationQueue';
import { errMsg, makeJobs, type RunConfig, sleepWhile } from './engine';
import { assertBenchmarkSuccess } from './queueValidation';
import type { BenchmarkStats } from './runtimeState';

export interface BenchmarkLoopContext {
  batch: number;
  blob: string;
  client: ServerTargetClient;
  compensationQueue: BenchmarkCompensationQueue;
  deadline: number;
  isCurrent: () => boolean;
  ownJobIds: Set<string>;
  payload: number;
  pendingPushes: Set<Promise<void>>;
  processMs: number;
  producersDone: () => boolean;
  queue: string;
  runId: string;
  runConfig: RunConfig;
  shouldContinue: () => boolean;
  stats: BenchmarkStats;
  stop: () => void;
  total: number;
  workerBatch: number;
}

interface PulledBenchmarkJob {
  id: string;
  token: string;
}

export function createProducer(context: BenchmarkLoopContext): () => Promise<void> {
  return async () => {
    const { stats } = context;
    while (context.shouldContinue()) {
      let size: number;
      if (context.runConfig.mode === 'count') {
        if (stats.assigned >= context.total) break;
        size = Math.min(context.batch, context.total - stats.assigned);
      } else {
        if (performance.now() >= context.deadline) break;
        size = context.batch;
      }
      const base = stats.assigned;
      stats.assigned += size;
      const jobs = makeJobs(
        base,
        size,
        context.blob,
        context.runConfig.durable,
        context.runConfig.removeOnComplete,
        context.runId,
        Math.max(120_000, context.processMs + 60_000)
      );
      const startedAt = performance.now();
      const request = context.client
        .addJobsBulk(context.queue, jobs)
        .then((response) => {
          if (!context.isCurrent()) return;
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
          for (const id of ids) context.ownJobIds.add(id);
          stats.pushed += ids.length;
          stats.bytes += ids.length * context.payload;
          const shortfall = Math.max(0, size - ids.length);
          if (shortfall > 0) {
            stats.pushFailed += shortfall;
            stats.error ??= `Server created ${ids.length} of ${size} jobs in a benchmark batch.`;
          }
        })
        .catch((error) => {
          if (!context.isCurrent()) return;
          stats.pushFailed += size;
          stats.error ??= errMsg(error);
        });
      context.pendingPushes.add(request);
      try {
        await request;
      } finally {
        context.pendingPushes.delete(request);
      }
      if (context.isCurrent()) stats.pushLat.push(performance.now() - startedAt);
    }
  };
}

export function createConsumer(context: BenchmarkLoopContext): () => Promise<void> {
  return async () => {
    const { stats } = context;
    while (context.shouldContinue()) {
      if (context.runConfig.mode === 'duration' && performance.now() >= context.deadline) break;
      if (context.runConfig.mode === 'count' && stats.completed >= context.total) break;
      stats.activeWorkers++;
      let jobs: PulledBenchmarkJob[] = [];
      try {
        jobs = await pullJobs(context);
        if (!context.shouldContinue()) {
          await restoreInterruptedJobs(context, jobs);
          break;
        }
        if (jobs.length > 0) await processJobs(context, jobs);
      } finally {
        if (context.isCurrent()) stats.activeWorkers--;
      }
      if (!context.shouldContinue()) break;
      if (jobs.length === 0) {
        if (context.runConfig.mode === 'count' && context.producersDone()) {
          if (context.ownJobIds.size > 0) {
            stats.error ??= `${context.ownJobIds.size} benchmark job(s) could not be drained.`;
          }
          break;
        }
        await sleepWhile(50, context.shouldContinue);
      }
    }
  };
}

async function pullJobs(context: BenchmarkLoopContext): Promise<PulledBenchmarkJob[]> {
  try {
    const response = await context.client.pullBatch(
      context.queue,
      context.workerBatch,
      `dashboard-benchmark:${context.runId}`
    );
    if (
      response?.ok !== true ||
      !Array.isArray(response.jobs) ||
      response.jobs.length > context.workerBatch ||
      response.jobs.some(
        (job) =>
          !job || typeof job !== 'object' || typeof job.id !== 'string' || job.id.length === 0
      ) ||
      !Array.isArray(response.tokens) ||
      response.tokens.length !== response.jobs.length ||
      response.tokens.some((token) => typeof token !== 'string' || token.length === 0) ||
      new Set(response.jobs.map((job) => job.id)).size !== response.jobs.length
    ) {
      throw new Error('Malformed pull-batch response.');
    }
    const jobs = response.jobs.map((job, index) => ({
      id: job.id,
      token: response.tokens?.[index] as string,
    }));
    if (!context.shouldContinue()) {
      await restoreInterruptedJobs(context, jobs);
      return [];
    }
    return jobs;
  } catch (error) {
    if (context.isCurrent()) context.stats.error ??= errMsg(error);
    return [];
  }
}

async function processJobs(context: BenchmarkLoopContext, jobs: PulledBenchmarkJob[]) {
  if (jobs.some((job) => !context.ownJobIds.has(job.id)) && context.pendingPushes.size > 0) {
    await Promise.allSettled([...context.pendingPushes]);
  }
  if (!context.shouldContinue()) return restoreInterruptedJobs(context, jobs);

  const own = jobs.filter((job) => context.ownJobIds.has(job.id));
  const foreign = jobs.filter((job) => !context.ownJobIds.has(job.id));
  if (foreign.length > 0) {
    await restoreForeignJobs(context, jobs, foreign.length);
    return;
  }
  if (own.length === 0) return;
  if (!context.shouldContinue()) return restoreInterruptedJobs(context, own);
  if (context.processMs > 0) await sleepWhile(context.processMs, context.shouldContinue);
  if (!context.shouldContinue()) return restoreInterruptedJobs(context, own);

  let ackStarted = false;
  try {
    const ids = own.map((job) => job.id);
    const tokens = own.map((job) => job.token);
    const heartbeat = await context.client.heartbeatBatch(ids, tokens);
    assertBenchmarkSuccess(heartbeat, 'Heartbeat benchmark jobs');
    const data = heartbeat.data;
    if (
      !data ||
      typeof data !== 'object' ||
      data.ok !== true ||
      !Number.isSafeInteger(data.count) ||
      data.count !== own.length
    ) {
      throw new Error(
        `Heartbeat confirmed ${String(data?.count)} of ${own.length} benchmark jobs; refusing a lossy batch ACK.`
      );
    }
    if (!context.shouldContinue()) return restoreInterruptedJobs(context, own);
    ackStarted = true;
    const response = await context.client.ackBatch(ids, tokens);
    assertBenchmarkSuccess(response, 'Acknowledge benchmark jobs');
    if (!context.isCurrent()) return;
    context.stats.completed += own.length;
    for (const job of own) context.ownJobIds.delete(job.id);
  } catch (error) {
    if (context.isCurrent()) {
      context.stats.ackFailed += own.length;
      context.stats.error ??= errMsg(error);
    }
    // Before ACK there is no ambiguous completion: best-effort release every
    // reservation, including when Stop/unmount coincides with a rejected or
    // malformed heartbeat. Once ACK has started its transport may have applied
    // the completion despite rejecting locally, so retrying would be unsafe.
    if (!ackStarted) await restoreInterruptedJobs(context, own);
  }
}

async function restoreForeignJobs(
  context: BenchmarkLoopContext,
  pulled: PulledBenchmarkJob[],
  foreignCount: number
) {
  const failures = await returnToWaiting(context, pulled);
  if (context.isCurrent()) {
    context.stats.error ??=
      failures > 0
        ? `Detected ${foreignCount} foreign job(s); ${failures} pulled job(s) could not be returned to waiting. Benchmark stopped.`
        : `Detected ${foreignCount} foreign job(s); returned the complete pulled batch to waiting and stopped without counting it.`;
  }
  context.stop();
}

async function restoreInterruptedJobs(
  context: BenchmarkLoopContext,
  jobs: PulledBenchmarkJob[]
): Promise<void> {
  if (jobs.length === 0) return;
  const failures = await returnToWaiting(context, jobs);
  if (failures > 0 && context.isCurrent()) {
    context.stats.error ??= `${failures} interrupted benchmark job(s) could not be returned to waiting.`;
  }
}

async function returnToWaiting(
  context: BenchmarkLoopContext,
  jobs: PulledBenchmarkJob[]
): Promise<number> {
  const restored = await Promise.allSettled(
    jobs.map((job) =>
      context.compensationQueue.run(async () => {
        const response = await context.client.retryJob(job.id, job.token);
        assertBenchmarkSuccess(response, `Restore job ${job.id}`);
        context.ownJobIds.delete(job.id);
      })
    )
  );
  return restored.filter((result) => result.status === 'rejected').length;
}
