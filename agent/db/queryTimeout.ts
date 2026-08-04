import { createQueryWorker } from './workerFactory';
import {
  MAX_CONCURRENT_QUERIES,
  MissingDbError,
  QUERY_TIMEOUT_MS,
  type DbQueryResult,
} from './types';

let liveQueryWorkers = 0;

/** Query worker threads currently alive, including timed-out queries. */
export const queryWorkerLoad = (): number => liveQueryWorkers;

export async function queryWithTimeout(path: string, sql: string): Promise<DbQueryResult> {
  if (liveQueryWorkers >= MAX_CONCURRENT_QUERIES) {
    throw new Error(
      `Too many queries running (${liveQueryWorkers}/${MAX_CONCURRENT_QUERIES}). A previous query timed out and is still running inside SQLite — wait for it to finish, or restart the agent.`
    );
  }
  let worker: Worker;
  try {
    worker = createQueryWorker();
  } catch (error) {
    throw new Error(`Query worker unavailable: ${(error as Error).message ?? String(error)}`);
  }
  liveQueryWorkers++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    liveQueryWorkers--;
  };
  worker.addEventListener('close', release);
  try {
    return await new Promise<DbQueryResult>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        worker.terminate();
        reject(
          new Error(
            `Query exceeded the ${QUERY_TIMEOUT_MS / 1000}s time limit and was abandoned (it may keep running inside SQLite until it completes).`
          )
        );
      }, QUERY_TIMEOUT_MS);
      worker.addEventListener('message', (event: MessageEvent) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        release();
        const response = event.data as {
          ok: boolean;
          result?: DbQueryResult;
          error?: string;
          missing?: boolean;
        };
        if (response.ok && response.result) resolve(response.result);
        else if (response.missing) {
          reject(new MissingDbError(response.error ?? 'Database not found'));
        } else reject(new Error(response.error ?? 'Query failed'));
      });
      worker.addEventListener('error', (event: ErrorEvent) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        release();
        event.preventDefault?.();
        reject(new Error(`Query worker failed: ${event.message || 'unknown worker error'}`));
      });
      worker.postMessage({ path, sql });
    });
  } finally {
    worker.terminate();
  }
}
