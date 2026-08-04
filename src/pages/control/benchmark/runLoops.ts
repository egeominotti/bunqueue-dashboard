import type { ServerTargetClient } from '@/lib/bq';
import { errMsg, makeJobs, type RunConfig, sleepWhile } from './engine';
import { assertBenchmarkSuccess } from './queueValidation';
import type { BenchmarkStats } from './runtimeState';

export interface BenchmarkLoopContext {
  batch: number;
  blob: string;
  client: ServerTargetClient;
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
      let jobs: { id: string }[] = [];
      try {
        jobs = await pullJobs(context);
        if (!context.shouldContinue()) break;
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

async function pullJobs(context: BenchmarkLoopContext): Promise<{ id: string }[]> {
  try {
    const response = await context.client.pullBatch(context.queue, context.workerBatch);
    if (!context.shouldContinue()) return [];
    if (
      response?.ok !== true ||
      !Array.isArray(response.jobs) ||
      response.jobs.length > context.workerBatch ||
      response.jobs.some(
        (job) =>
          !job || typeof job !== 'object' || typeof job.id !== 'string' || job.id.length === 0
      ) ||
      new Set(response.jobs.map((job) => job.id)).size !== response.jobs.length
    ) {
      throw new Error('Malformed pull-batch response.');
    }
    return response.jobs;
  } catch (error) {
    if (context.isCurrent()) context.stats.error ??= errMsg(error);
    return [];
  }
}

async function processJobs(context: BenchmarkLoopContext, jobs: { id: string }[]) {
  if (jobs.some((job) => !context.ownJobIds.has(job.id)) && context.pendingPushes.size > 0) {
    await Promise.allSettled([...context.pendingPushes]);
  }
  if (!context.shouldContinue()) return;

  const own = jobs.filter((job) => context.ownJobIds.has(job.id));
  const foreign = jobs.filter((job) => !context.ownJobIds.has(job.id));
  if (foreign.length > 0) await restoreForeignJobs(context, foreign);
  if (own.length === 0 || !context.shouldContinue()) return;
  if (context.processMs > 0) await sleepWhile(context.processMs, context.shouldContinue);
  if (!context.shouldContinue()) return;

  try {
    const ids = own.map((job) => job.id);
    const heartbeat = await context.client.heartbeatBatch(ids);
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
    if (!context.shouldContinue()) return;
    const response = await context.client.ackBatch(ids);
    assertBenchmarkSuccess(response, 'Acknowledge benchmark jobs');
    if (!context.isCurrent()) return;
    context.stats.completed += own.length;
    for (const job of own) context.ownJobIds.delete(job.id);
  } catch (error) {
    if (!context.isCurrent()) return;
    context.stats.ackFailed += own.length;
    context.stats.error ??= errMsg(error);
  }
}

async function restoreForeignJobs(context: BenchmarkLoopContext, foreign: Array<{ id: string }>) {
  if (!context.shouldContinue()) return;
  const restored = await Promise.allSettled(
    foreign.map(async (job) => {
      const response = await context.client.retryJob(job.id);
      assertBenchmarkSuccess(response, `Restore job ${job.id}`);
    })
  );
  if (!context.isCurrent()) return;
  const failures = restored.filter((result) => result.status === 'rejected');
  context.stats.error ??=
    failures.length > 0
      ? `Detected ${foreign.length} foreign job(s); ${failures.length} could not be returned to waiting. Benchmark stopped.`
      : `Detected ${foreign.length} foreign job(s); returned them to waiting and stopped without counting them.`;
  context.stop();
}
