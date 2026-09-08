import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBoundedBytes } from '../agent/db/boundedStream';
import { exportWithTimeout, exportWorkerLoad } from '../agent/db/exportTimeout';
import {
  DatabaseProcessWorker,
  databaseProcessLoad,
  terminateDatabaseProcesses,
} from '../agent/db/processWorker';
import { queryWithTimeout, queryWorkerLoad, readWithTimeout } from '../agent/db/queryTimeout';
import { dispatchRead } from '../agent/db/readOperations';
import { MissingDbError } from '../agent/db/types';
import { ProcessManager } from '../agent/manager';
import { createFetchHandler } from '../agent/server';

const directory = mkdtempSync(join(tmpdir(), 'bq-db-process-'));
const path = join(directory, 'store.db');
const endless =
  'WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n) SELECT sum(x) FROM n';
beforeAll(() => {
  const db = new Database(path);
  db.run(
    "CREATE TABLE jobs(id INTEGER PRIMARY KEY, data TEXT); INSERT INTO jobs VALUES(1,'hello'),(2,'world')"
  );
  db.close();
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe('killable SQLite reads', () => {
  test('a real unbounded SQLite statement times out, exits, and immediately releases admission', async () => {
    await expect(readWithTimeout('dbQuery', [path, endless], undefined, 150)).rejects.toThrow(
      'time limit'
    );
    expect(queryWorkerLoad()).toBe(0);
    expect(databaseProcessLoad()).toBe(0);
    expect((await queryWithTimeout(path, 'SELECT 42 AS answer')).rows).toEqual([[42]]);
  });

  test('client cancellation waits for the child exit and leaves control endpoints responsive', async () => {
    const manager = new ProcessManager();
    manager.setConfig({ dataPath: path });
    const handle = createFetchHandler(manager, { allowedOrigins: [] });
    const controller = new AbortController();
    const pending = handle(
      new Request('http://localhost/db/query', {
        method: 'POST',
        body: JSON.stringify({ sql: endless }),
        signal: controller.signal,
      })
    );
    await Bun.sleep(80);
    const started = performance.now();
    expect((await handle(new Request('http://localhost/control/status'))).status).toBe(200);
    expect(performance.now() - started).toBeLessThan(1000);
    controller.abort(new Error('disconnected'));
    expect((await pending).status).toBe(400);
    expect(databaseProcessLoad()).toBe(0);
    await handle.close();
  });

  test('browse, metadata and workflow reads use the same isolated protocol', async () => {
    expect(await readWithTimeout('dbTables', [path])).toEqual([
      { name: 'jobs', rows: 2, columns: 2 },
    ]);
    expect((await readWithTimeout('dbRows', [path, 'jobs'])).total).toBe(2);
    expect((await readWithTimeout('dbSchema', [path, 'jobs'])).rowCount).toBe(2);
    expect((await readWithTimeout('dbInfo', [path])).tables).toBe(1);
    expect(await readWithTimeout('workflowExecution', [path, 'absent'])).toBeNull();
    expect((await readWithTimeout('workflowExecutions', [path])).available).toBe(false);
    expect((await readWithTimeout('workflowStats', [path])).available).toBe(false);
    expect((await readWithTimeout('dbCell', [path, 'jobs', 1, 'data'])).value).toBe('hello');
    const exported = await exportWithTimeout(path, 'jobs');
    expect(new TextDecoder().decode(exported.content)).toContain('hello');
    expect(exported.bytes).toBe(exported.content.byteLength);
    expect(exportWorkerLoad()).toBe(0);
    expect(databaseProcessLoad()).toBe(0);
  });

  test('parallel page reads finish without transient overload errors or extra processes', async () => {
    const burst = Array.from({ length: 8 }, () => readWithTimeout('dbRows', [path, 'jobs']));
    expect(queryWorkerLoad()).toBe(2);
    const pages = await Promise.all(burst);
    expect(pages.every((page) => page.total === 2)).toBe(true);
    expect(queryWorkerLoad()).toBe(0);
    expect(databaseProcessLoad()).toBe(0);
  });

  test('missing files preserve 404 semantics and SQLite errors release capacity', async () => {
    await expect(queryWithTimeout(join(directory, 'absent.db'), 'SELECT 1')).rejects.toBeInstanceOf(
      MissingDbError
    );
    await expect(queryWithTimeout(path, 'SELECT * FROM absent_table')).rejects.toThrow();
    expect(databaseProcessLoad()).toBe(0);
    expect((await queryWithTimeout(path, 'SELECT 1')).rowCount).toBe(1);
  });

  test('dispatch rejects unknown operations; bounded pipes reject oversized output', async () => {
    expect(() => dispatchRead(null)).toThrow('Invalid');
    expect(() => dispatchRead({ operation: 'constructor', args: [] })).toThrow('Unknown');
    expect(dispatchRead({ operation: 'dbQuery', args: [path, 'SELECT 7 AS n'] })).toMatchObject({
      rows: [[7]],
    });
    expect(await readBoundedBytes(new Response('abcd').body!, 4)).toEqual(Buffer.from('abcd'));
    await expect(readBoundedBytes(new Response('abcde').body!, 4)).rejects.toThrow('byte limit');
    const worker = new DatabaseProcessWorker();
    worker.terminate();
    await worker.exited;
    expect(() => worker.postMessage({})).toThrow('already used');
  });

  test('terminal cleanup kills all live database processes and waits for reaping', async () => {
    const worker = new DatabaseProcessWorker();
    worker.postMessage({ operation: 'dbQuery', args: [path, endless] });
    expect(worker.pid).toBeGreaterThan(0);
    terminateDatabaseProcesses();
    await worker.exited;
    expect(databaseProcessLoad()).toBe(0);
  });

  test('SQLite work exits even when its parent is killed without running cleanup', async () => {
    const parent = Bun.spawn(
      [
        process.execPath,
        '-e',
        `
      import { DatabaseProcessWorker } from ${JSON.stringify(new URL('../agent/db/processWorker.ts', import.meta.url).href)};
      const worker = new DatabaseProcessWorker();
      worker.postMessage({operation:'dbQuery',args:${JSON.stringify([path, endless])}});
      console.log(worker.pid);
      setInterval(() => {}, 1000);
    `,
      ],
      { stdout: 'pipe', stderr: 'ignore' }
    );
    const reader = parent.stdout.getReader();
    let pid: number | undefined;
    try {
      const first = await reader.read();
      pid = Number(new TextDecoder().decode(first.value));
      expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
      await Bun.sleep(100); // Let the actual SQLite statement enter its unbounded step.
      parent.kill('SIGKILL');
      await parent.exited;
      const deadline = Date.now() + 2000;
      let alive = true;
      while (alive && Date.now() < deadline) {
        try {
          process.kill(pid, 0);
          await Bun.sleep(20);
        } catch {
          alive = false;
        }
      }
      expect(alive).toBe(false);
    } finally {
      reader.releaseLock();
      if (parent.exitCode === null) {
        parent.kill('SIGKILL');
        await parent.exited;
      }
      if (pid) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* already reaped */
        }
      }
    }
  });
});
