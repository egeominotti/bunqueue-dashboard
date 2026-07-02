/**
 * Disposable worker that runs ONE read-only query and posts the result back.
 *
 * queryWithTimeout() (agent/db.ts) spawns one of these per /db/query request and
 * races it against a wall clock; on timeout the parent terminate()s this worker,
 * so a runaway O(N^k) scan is killed instead of pinning the agent's only thread
 * and freezing the process-control endpoints. The connection is opened readonly
 * inside dbQuery, so nothing here can mutate the store.
 */
import { dbQuery } from './db';

declare const self: Worker;

self.addEventListener('message', (ev: MessageEvent) => {
  const { path, sql } = ev.data as { path: string; sql: string };
  try {
    self.postMessage({ ok: true, result: dbQuery(path, sql) });
  } catch (e) {
    self.postMessage({ ok: false, error: (e as Error).message ?? String(e) });
  }
});
