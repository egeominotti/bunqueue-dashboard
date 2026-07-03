/**
 * Run `fn` over `items` with at most `limit` in flight at once, never rejecting —
 * every item resolves to a PromiseSettledResult (like Promise.allSettled, but
 * bounded). Used by the incident-recovery fan-outs (pause-all queues, cross-queue
 * DLQ retry/purge) so they don't fire hundreds of concurrent requests at a server
 * that is, by definition, already under stress.
 */
export async function settledPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    let i = next++;
    while (i < items.length) {
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i], i) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
      i = next++;
    }
  };
  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}
