import { describe, expect, test } from 'bun:test';
import type { ServerTargetClient } from '../src/lib/bq';
import { createBenchmarkCompensationQueue } from '../src/pages/control/benchmark/compensationQueue';
import { DEFAULT_CONFIG } from '../src/pages/control/benchmark/engine';
import { type BenchmarkLoopContext, createConsumer } from '../src/pages/control/benchmark/runLoops';
import { freshBenchmarkStats } from '../src/pages/control/benchmark/runtimeState';

describe('benchmark compensation pressure', () => {
  test('all workers share one bounded FIFO and continue after retry rejection', async () => {
    const workerCount = 4;
    const jobsPerWorker = 12;
    const batches = Array.from({ length: workerCount }, (_, worker) =>
      Array.from({ length: jobsPerWorker }, (_, index) => ({
        id: `job-${worker}-${index}`,
        token: `lock-${worker}-${index}`,
      }))
    );
    const allIds = batches.flat().map((job) => job.id);
    const failedIds = new Set(batches.map((_, worker) => `job-${worker}-0`));
    const allPulled = deferred<void>();
    const releasePulls = deferred<void>();
    let nextBatch = 0;
    let running = true;
    let activeRetries = 0;
    let maxActiveRetries = 0;
    const attempts: string[] = [];
    const client = {
      pullBatch: async () => {
        const jobs = batches[nextBatch++] ?? [];
        if (nextBatch === workerCount) allPulled.resolve();
        await releasePulls.promise;
        return { ok: true, jobs, tokens: jobs.map((job) => job.token) };
      },
      retryJob: async (id: string) => {
        attempts.push(id);
        activeRetries += 1;
        maxActiveRetries = Math.max(maxActiveRetries, activeRetries);
        try {
          await Bun.sleep(2);
          if (failedIds.has(id)) throw new Error(`retry failed for ${id}`);
          return { ok: true };
        } finally {
          activeRetries -= 1;
        }
      },
    } as ServerTargetClient;
    const stats = freshBenchmarkStats();
    const context: BenchmarkLoopContext = {
      batch: 1,
      blob: '',
      client,
      compensationQueue: createBenchmarkCompensationQueue(3),
      deadline: Number.POSITIVE_INFINITY,
      isCurrent: () => true,
      ownJobIds: new Set(allIds),
      payload: 0,
      pendingPushes: new Set(),
      processMs: 0,
      producersDone: () => true,
      queue: 'benchmark',
      runId: 'run-1',
      runConfig: {
        ...DEFAULT_CONFIG,
        total: allIds.length,
        workers: workerCount,
        workerBatch: jobsPerWorker,
      },
      shouldContinue: () => running,
      stats,
      stop: () => {
        running = false;
      },
      total: allIds.length,
      workerBatch: jobsPerWorker,
    };

    const consumers = Array.from({ length: workerCount }, createConsumer(context));
    await allPulled.promise;
    running = false;
    releasePulls.resolve();
    await Promise.all(consumers);

    expect(attempts.sort()).toEqual([...allIds].sort());
    expect(maxActiveRetries).toBe(3);
    expect(context.ownJobIds).toEqual(failedIds);
    expect(stats.error).toContain('interrupted benchmark job(s) could not be returned');
  });

  test('a synchronous failure releases its slot and queued work remains FIFO', async () => {
    const queue = createBenchmarkCompensationQueue(1);
    const events: string[] = [];
    const failed = queue.run(async () => {
      events.push('first');
      throw new Error('synchronous operation failure');
    });
    const second = queue.run(async () => {
      events.push('second');
      return 2;
    });
    const third = queue.run(async () => {
      events.push('third');
      return 3;
    });

    await expect(failed).rejects.toThrow('synchronous operation failure');
    await expect(Promise.all([second, third])).resolves.toEqual([2, 3]);
    expect(events).toEqual(['first', 'second', 'third']);
    expect(() => createBenchmarkCompensationQueue(0)).toThrow('positive whole number');
    expect(() => createBenchmarkCompensationQueue(1.5)).toThrow('positive whole number');
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}
