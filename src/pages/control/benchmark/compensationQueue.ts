export const MAX_COMPENSATION_CONCURRENCY = 8;

export interface BenchmarkCompensationQueue {
  run<T>(operation: () => Promise<T>): Promise<T>;
}

/** One FIFO shared by every worker in a benchmark run. */
export function createBenchmarkCompensationQueue(
  limit = MAX_COMPENSATION_CONCURRENCY
): BenchmarkCompensationQueue {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError('Benchmark compensation concurrency must be a positive whole number');
  }
  let active = 0;
  const waiting: Array<() => void> = [];

  const release = () => {
    active -= 1;
    waiting.shift()?.();
  };

  return Object.freeze({
    run<T>(operation: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const start = () => {
          active += 1;
          void Promise.resolve().then(operation).then(resolve, reject).finally(release);
        };
        if (active < limit) start();
        else waiting.push(start);
      });
    },
  });
}
