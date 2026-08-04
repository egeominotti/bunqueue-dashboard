const RUNNABLE_STATES = [
  'waiting',
  'prioritized',
  'delayed',
  'active',
  'paused',
  'waiting-children',
] as const;

export const BENCHMARK_QUEUE_STATES = [...RUNNABLE_STATES, 'completed', 'failed'] as const;

export function runnableQueueJobs(counts: Record<string, number>): number {
  return RUNNABLE_STATES.reduce((total, state) => {
    const value = counts[state] ?? 0;
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Malformed queue count for "${state}".`);
    }
    return total + value;
  }, 0);
}

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
