import { ReadAdmission } from './readAdmission';
import { createQueryWorker } from './workerFactory';
import type { ReadArguments, ReadOperation, ReadResult } from './readOperations';
import {
  DbReadUnavailableError,
  MissingDbError, QUERY_TIMEOUT_MS, type DbQueryResult,
} from './types';

const admission = new ReadAdmission();
/** Active database read processes, including children being reaped after cancellation. */
export const queryWorkerLoad = (): number => admission.load;

export function queryWithTimeout(path: string, sql: string, signal?: AbortSignal): Promise<DbQueryResult> {
  return runReadWorker({ path, sql }, signal);
}

/** Every HTTP SQLite read shares the same bounded admission pool. */
export function readWithTimeout<K extends ReadOperation>(
  operation: K, args: ReadArguments<K>, signal?: AbortSignal,
  timeoutMs = QUERY_TIMEOUT_MS
): Promise<ReadResult<K>> {
  return runReadWorker({ operation, args }, signal, timeoutMs, true);
}

async function runReadWorker<T>(request: unknown, signal?: AbortSignal, timeoutMs = QUERY_TIMEOUT_MS, queue = false): Promise<T> {
  const limit = Math.max(1, Math.min(timeoutMs, QUERY_TIMEOUT_MS));
  const deadline = performance.now() + limit;
  const ticket = admission.acquire(queue, deadline, signal);
  const release = typeof ticket === 'function' ? ticket : await ticket;
  let worker;
  try {
    signal?.throwIfAborted();
    if (performance.now() >= deadline) throw new Error('Database read exceeded the time limit while waiting for capacity');
    worker = createQueryWorker();
  } catch (error) {
    release();
    throw new DbReadUnavailableError(`Query worker unavailable: ${(error as Error).message}`);
  }
  let cleanup = () => {};
  try {
    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        worker.terminate();
        reject(error);
      };
      const onAbort = () => fail(signal?.reason instanceof Error ? signal.reason : new Error('Database read aborted'));
      const timer = setTimeout(() => fail(new DbReadUnavailableError(
        `Query exceeded the ${limit / 1000}s time limit and was terminated.`
      )), Math.max(1, deadline - performance.now()));
      cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
      worker.addEventListener('close', () => {
        release();
        if (!settled) fail(new DbReadUnavailableError('Query worker exited unexpectedly'));
      });
      worker.addEventListener('message', (event) => {
        if (settled) return;
        const response = event.data as { ok?: unknown; result?: unknown; missing?: unknown; error?: unknown } | null;
        if (!response || typeof response !== 'object' || typeof response.ok !== 'boolean') {
          fail(new DbReadUnavailableError('Query worker returned a malformed response'));
          return;
        }
        settled = true;
        cleanup();
        if (!worker.exited) release();
        if (response.ok && Object.hasOwn(response, 'result')) resolve(response.result as T);
        else if (response.missing === true) reject(new MissingDbError(typeof response.error === 'string' ? response.error : 'Database not found'));
        else reject(new Error(typeof response.error === 'string' ? response.error : 'Query failed'));
      });
      worker.addEventListener('error', (event) => {
        event.preventDefault?.();
        fail(new DbReadUnavailableError(`Query worker failed: ${event.message || 'unknown worker error'}`));
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) { onAbort(); return; }
      try { worker.postMessage(request); } catch (error) {
        fail(new DbReadUnavailableError(`Could not start database read: ${(error as Error).message}`));
      }
    });
  } finally {
    cleanup();
    worker.terminate();
    if (worker.exited) { await worker.exited; release(); }
  }
}
