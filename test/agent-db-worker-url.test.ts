import { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { exportWithTimeout, exportWorkerLoad } from '../agent/db/exportTimeout';
import { databaseProcessLoad } from '../agent/db/processWorker';
import { queryWithTimeout, queryWorkerLoad, readWithTimeout } from '../agent/db/queryTimeout';
import { setQueryWorkerUrl } from '../agent/db/workerFactory';

const directory = mkdtempSync(join(tmpdir(), 'bq-worker-url-'));
const databasePath = join(directory, 'store.db');
const workerPath = join(directory, 'custom-worker.ts');
const workerUrl = pathToFileURL(workerPath).href;

beforeAll(() => {
  const database = new Database(databasePath);
  database.close();
  writeFileSync(
    workerPath,
    `self.onmessage = ({ data }) => {
      if (data.sql === 'loop') { while (true) {} }
      if (data.kind === 'export') {
        const content = new TextEncoder().encode('custom csv');
        self.postMessage({ ok: true, result: undefined, export: {
          table: data.table, content, bytes: content.byteLength, rowCount: 1, cap: null,
        } });
      } else {
        self.postMessage({ ok: true, result: {
          columns: ['pid', 'sql'], rows: [[process.pid, data.sql]], rowCount: 1,
        } });
      }
    };`
  );
});
afterEach(() => {
  setQueryWorkerUrl(null);
  expect(databaseProcessLoad()).toBe(0);
  expect(queryWorkerLoad()).toBe(0);
  expect(exportWorkerLoad()).toBe(0);
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

test('an explicit URL receives the legacy query and export messages in another process', async () => {
  setQueryWorkerUrl(workerUrl);
  const queried = await queryWithTimeout(databasePath, 'custom request');
  expect(queried.rows[0]?.[0]).toBeNumber();
  expect(queried.rows[0]?.[0]).not.toBe(process.pid);
  expect(queried.rows[0]?.[1]).toBe('custom request');
  const exported = await exportWithTimeout(databasePath, 'jobs');
  expect(new TextDecoder().decode(exported.content)).toBe('custom csv');
  expect(exported.rowCount).toBe(1);
});

test('an infinite custom worker is killed on cancellation and releases capacity', async () => {
  setQueryWorkerUrl(workerUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('cancel custom worker')), 150);
  try {
    await expect(queryWithTimeout(databasePath, 'loop', controller.signal)).rejects.toThrow(
      'cancel custom worker'
    );
  } finally {
    clearTimeout(timer);
  }
});

test('a missing custom worker fails without leaking a process or admission slot', async () => {
  setQueryWorkerUrl(pathToFileURL(join(directory, 'missing-worker.ts')).href);
  await expect(queryWithTimeout(databasePath, 'SELECT 1')).rejects.toThrow();
});

test('clearing the override restores the built-in SQLite reader', async () => {
  setQueryWorkerUrl(workerUrl);
  setQueryWorkerUrl(null);
  expect((await queryWithTimeout(databasePath, 'SELECT 42 AS answer')).rows).toEqual([[42]]);
});

test('a legacy query/export override does not replace ordinary browse and workflow reads', async () => {
  setQueryWorkerUrl(workerUrl);
  expect(await readWithTimeout('dbTables', [databasePath])).toEqual([]);
  expect((await readWithTimeout('workflowStats', [databasePath])).available).toBe(false);
});
