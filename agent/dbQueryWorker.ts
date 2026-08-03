/**
 * Disposable worker that runs ONE read-only database operation and posts the
 * result back: an arbitrary query or an atomic table CSV export.
 *
 * queryWithTimeout() and exportWithTimeout() (agent/db.ts) spawn one of these
 * per request and race it against a wall clock, so a runaway scan/sort can't
 * freeze the agent's process-control endpoints. terminate() does NOT preempt a
 * synchronous sqlite3_step, though — it abandons the response, and this thread
 * keeps running until SQLite finishes, which is why db.ts caps how many can be
 * alive at once. Both dbQuery and dbExportCsv open readonly connections, so
 * nothing here can mutate the store.
 */
import { type DbFilter, dbExportCsv, dbQuery, MissingDbError } from './db';

declare const self: Worker;

self.addEventListener('message', (ev: MessageEvent) => {
  const request = ev.data as
    | { kind?: 'query'; path: string; sql: string }
    | {
        kind: 'export';
        path: string;
        table: string;
        orderBy?: string;
        dir: 'asc' | 'desc';
        filter?: DbFilter;
      };
  try {
    if (request.kind === 'export') {
      const exported = dbExportCsv(
        request.path,
        request.table,
        request.orderBy,
        request.dir,
        request.filter
      );
      // Transfer the bounded CSV buffer instead of cloning it or JSON-encoding
      // up to 16 MiB a second time in either isolate.
      self.postMessage({ ok: true, export: exported }, [exported.content.buffer]);
    } else {
      self.postMessage({ ok: true, result: dbQuery(request.path, request.sql) });
    }
  } catch (e) {
    // postMessage can't carry the error class, so flag the one the route branches
    // on (MissingDbError → 404) and let db.ts rebuild it on the parent side.
    self.postMessage({
      ok: false,
      error: (e as Error).message ?? String(e),
      missing: e instanceof MissingDbError,
    });
  }
});
