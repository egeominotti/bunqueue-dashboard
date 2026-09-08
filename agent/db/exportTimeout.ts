import { validateWorkerBounds } from './core';
import type { DatabaseWorker } from './processWorker';
import { createExportWorker } from './workerFactory';
import {
  DB_EXPORT_MAX_ROWS,
  DB_EXPORT_TIMEOUT_MS,
  DbExportBusyError,
  DbExportUnavailableError,
  MAX_CONCURRENT_EXPORTS,
  MissingDbError,
  type DbCsvExport,
  type DbExportCap,
  type DbFilter,
} from './types';

let liveExportWorkers = 0;

/** Export workers alive now, including cancelled children being reaped. */
export const exportWorkerLoad = (): number => liveExportWorkers;

function validatedWorkerExport(value: unknown, expectedTable: string): DbCsvExport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DbExportUnavailableError('Database export worker returned a malformed result');
  }
  const result = value as Record<string, unknown>;
  if (
    typeof result.table !== 'string' ||
    result.table !== expectedTable ||
    !(result.content instanceof Uint8Array) ||
    !Number.isSafeInteger(result.rowCount) ||
    !Number.isSafeInteger(result.bytes) ||
    !validateWorkerBounds(result.rowCount as number, result.bytes as number) ||
    result.content.byteLength !== result.bytes ||
    (result.cap !== null && result.cap !== 'rows' && result.cap !== 'bytes') ||
    (result.cap === 'rows' && result.rowCount !== DB_EXPORT_MAX_ROWS)
  ) {
    throw new DbExportUnavailableError('Database export worker returned a malformed result');
  }
  const content =
    result.content.buffer instanceof ArrayBuffer
      ? (result.content as Uint8Array<ArrayBuffer>)
      : Uint8Array.from(result.content);
  return {
    table: result.table,
    content,
    rowCount: result.rowCount as number,
    bytes: result.bytes as number,
    cap: result.cap as DbExportCap,
  };
}

interface WorkerResponse {
  ok?: unknown;
  export?: unknown;
  error?: unknown;
  missing?: unknown;
}

/** Run an atomic CSV export off the control-agent event loop. */
export async function exportWithTimeout(
  path: string,
  table: string,
  orderBy?: string,
  dir: 'asc' | 'desc' = 'asc',
  filter?: DbFilter,
  signal?: AbortSignal
): Promise<DbCsvExport> {
  signal?.throwIfAborted();
  if (liveExportWorkers >= MAX_CONCURRENT_EXPORTS) {
    throw new DbExportBusyError(
      'A database export is already running. Retry after it finishes.'
    );
  }

  let worker: DatabaseWorker;
  try {
    worker = createExportWorker();
  } catch (error) {
    throw new DbExportUnavailableError(
      `Database export worker unavailable: ${(error as Error).message ?? String(error)}`
    );
  }
  liveExportWorkers++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    liveExportWorkers--;
  };

  try {
    return await new Promise<DbCsvExport>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const abandon = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        worker.terminate();
        reject(error);
      };
      const onAbort = () =>
        abandon(
          signal?.reason instanceof Error
            ? signal.reason
            : new Error('Database export request was aborted')
        );

      worker.addEventListener('close', () => {
        release();
        if (!settled) {
          settled = true;
          cleanup();
          reject(new DbExportUnavailableError('Database export worker exited unexpectedly'));
        }
      });
      worker.addEventListener('message', (event) => {
        if (settled) return;
        settled = true;
        cleanup();
        release();
        const response = event.data as WorkerResponse | null;
        if (!response || typeof response !== 'object' || Array.isArray(response)) {
          reject(
            new DbExportUnavailableError('Database export worker returned a malformed response')
          );
        } else if (response.ok === true) {
          try {
            resolve(validatedWorkerExport(response.export, table));
          } catch (error) {
            reject(error);
          }
        } else if (response.missing === true) {
          reject(
            new MissingDbError(
              typeof response.error === 'string' ? response.error : 'Database not found'
            )
          );
        } else {
          reject(
            new Error(
              typeof response.error === 'string' ? response.error : 'Database export failed'
            )
          );
        }
      });
      worker.addEventListener('error', (event) => {
        if (settled) return;
        event.preventDefault?.();
        abandon(
          new DbExportUnavailableError(
            `Database export worker failed: ${event.message || 'unknown worker error'}`
          )
        );
      });

      timer = setTimeout(
        () =>
          abandon(
            new DbExportUnavailableError(
              `Database export exceeded the ${DB_EXPORT_TIMEOUT_MS / 1000}s time limit and was terminated.`
            )
          ),
        DB_EXPORT_TIMEOUT_MS
      );
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      try {
        worker.postMessage({ kind: 'export', path, table, orderBy, dir, filter });
      } catch (error) {
        settled = true;
        cleanup();
        release();
        reject(
          new DbExportUnavailableError(
            `Could not start database export: ${(error as Error).message ?? String(error)}`
          )
        );
      }
    });
  } finally {
    worker.terminate();
    if (worker.exited) { await worker.exited; release(); }
  }
}
