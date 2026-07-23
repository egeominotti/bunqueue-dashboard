/**
 * Disposable worker that runs ONE read-only query and posts the result back.
 *
 * queryWithTimeout() (agent/db.ts) spawns one of these per /db/query request and
 * races it against a wall clock, so a runaway O(N^k) scan can't freeze the
 * agent's process-control endpoints. terminate() does NOT preempt a synchronous
 * sqlite3_step, though — it abandons the response, and this thread keeps running
 * until SQLite finishes, which is why db.ts caps how many can be alive at once.
 * The connection is opened readonly inside dbQuery, so nothing here can mutate
 * the store.
 */
import { dbQuery, MissingDbError } from './db';

declare const self: Worker;

self.addEventListener('message', (ev: MessageEvent) => {
  const { path, sql } = ev.data as { path: string; sql: string };
  try {
    self.postMessage({ ok: true, result: dbQuery(path, sql) });
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
