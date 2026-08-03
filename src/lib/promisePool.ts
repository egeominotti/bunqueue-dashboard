/**
 * Run `fn` over `items` with at most `limit` in flight at once, never rejecting —
 * every item resolves to a PromiseSettledResult (like Promise.allSettled, but
 * bounded). An optional lifecycle signal stops assigning new work and marks
 * untouched items rejected. Used by fan-outs so they neither overload a server
 * nor keep consuming an obsolete target after a retarget/unmount.
 */
export async function settledPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal
): Promise<PromiseSettledResult<R>[]> {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError('Promise pool limit must be a positive whole number');
  }
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    let i = next++;
    while (i < items.length && !signal?.aborted) {
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i], i) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
      if (signal?.aborted) break;
      i = next++;
    }
  };
  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  if (signal?.aborted) {
    const reason = signal.reason ?? new DOMException('Aborted', 'AbortError');
    for (let index = 0; index < results.length; index++) {
      if (results[index] === undefined) results[index] = { status: 'rejected', reason };
    }
  }
  return results;
}
