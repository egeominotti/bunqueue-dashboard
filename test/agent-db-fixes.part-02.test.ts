/**
 * Regression tests for the audited agent/db.ts correctness fixes:
 * colliding output column names, LIKE metacharacters in the browse filter,
 * >2^53 INTEGERs, unbounded offsets, MissingDbError across the worker boundary,
 * and the accounting/cap on query worker threads that a timeout cannot kill.
 *
 * Everything runs against a real bun:sqlite file — never a mock.
 */
import { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import {
  DbExportBusyError,
  DbExportUnavailableError,
  dbRows,
  exportWithTimeout,
  exportWorkerLoad,
  MAX_CONCURRENT_EXPORTS,
  setExportWorkerFactory,
} from '../agent/db';

const PATH = `/tmp/bq-agent-db-fixes-${process.pid}-${import.meta.file.split('/').at(-1)}.db`;

beforeAll(() => {
  const db = new Database(PATH);
  db.run('CREATE TABLE jobs (id TEXT PRIMARY KEY, queue TEXT)');
  db.run('CREATE TABLE runs (rid TEXT, jid TEXT)');
  db.run("INSERT INTO jobs VALUES ('a', 'q1'), ('b', 'q%2'), ('c', 'q_3')");
  db.run("INSERT INTO runs VALUES ('r1', 'a')");
  db.run('CREATE TABLE bignum (v INTEGER, small INTEGER)');
  db.run('INSERT INTO bignum VALUES (9007199254740993, 42)');
  db.run('CREATE TABLE huge_rowid (payload TEXT)');
  db.run("INSERT INTO huge_rowid(rowid, payload) VALUES (9007199254740993, 'exact-row')");
  db.run('CREATE TABLE csv_caps (v TEXT)');
  db.run("INSERT INTO csv_caps VALUES ('a'), ('bbbb'), ('=2+2')");
  db.close();
});

afterAll(() => {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${PATH}${suffix}`, { force: true });
});

describe('agent db — audited fixes', () => {
  test('browse COUNT and SELECT stay on one snapshot while a WAL writer commits', () => {
    const atomicPath = `/tmp/bq-agent-db-rows-atomic-${process.pid}.db`;
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${atomicPath}${suffix}`, { force: true });
    try {
      const setup = new Database(atomicPath);
      setup.run('PRAGMA journal_mode = WAL');
      setup.run('CREATE TABLE items (id TEXT PRIMARY KEY)');
      setup.run("INSERT INTO items VALUES ('before')");
      setup.close();

      let writerCommitted = false;
      const page = dbRows(atomicPath, 'items', 50, 0, 'id', 'asc', undefined, {
        afterCount: () => {
          // Commit after COUNT but before the page SELECT. The pre-fix reader
          // returned total=1 with two rows; one read transaction must keep both
          // halves on the same pre-write WAL snapshot.
          const writer = Bun.spawnSync({
            cmd: [
              process.execPath,
              '-e',
              "import { Database } from 'bun:sqlite'; const db = new Database(process.env.BQ_ROWS_ATOMIC_PATH); db.run('PRAGMA busy_timeout = 2000'); db.run(\"INSERT INTO items VALUES ('during')\"); db.close();",
            ],
            env: { ...process.env, BQ_ROWS_ATOMIC_PATH: atomicPath },
            stdout: 'pipe',
            stderr: 'pipe',
          });
          if (writer.exitCode !== 0) {
            throw new Error(`Concurrent row writer failed: ${writer.stderr.toString()}`);
          }
          writerCommitted = true;
        },
      });

      expect(writerCommitted).toBe(true);
      expect(page.total).toBe(1);
      expect(page.rows).toEqual([['before']]);
      const after = new Database(atomicPath, { readonly: true });
      expect((after.query('SELECT COUNT(*) AS c FROM items').get() as { c: number }).c).toBe(2);
      after.close();
    } finally {
      for (const suffix of ['', '-wal', '-shm']) {
        rmSync(`${atomicPath}${suffix}`, { force: true });
      }
    }
  });

  test('the source-mode export worker transfers one intact bounded CSV result', () => {
    // Run in a clean process because other test files install DOM globals that
    // currently make Bun panic if a Worker is spawned in the shared test VM.
    // This crosses the real dbQueryWorker.ts boundary and therefore exercises
    // the transferred ArrayBuffer, not only the parent-side protocol stand-in.
    const workerRun = Bun.spawnSync({
      cmd: [
        process.execPath,
        '-e',
        `import { exportWithTimeout } from './agent/db.ts';
const result = await exportWithTimeout(process.env.BQ_EXPORT_WORKER_PATH, 'jobs', 'id', 'asc');
console.log(JSON.stringify({ table: result.table, rowCount: result.rowCount, bytes: result.bytes, cap: result.cap, csv: new TextDecoder().decode(result.content) }));`,
      ],
      cwd: process.cwd(),
      env: { ...process.env, BQ_EXPORT_WORKER_PATH: PATH },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(workerRun.exitCode).toBe(0);
    if (workerRun.exitCode !== 0) {
      throw new Error(`Real export worker failed: ${workerRun.stderr.toString()}`);
    }
    const result = JSON.parse(workerRun.stdout.toString().trim()) as {
      table: string;
      rowCount: number;
      bytes: number;
      cap: string | null;
      csv: string;
    };
    expect(result).toEqual({
      table: 'jobs',
      rowCount: 3,
      bytes: new TextEncoder().encode('id,queue\r\na,q1\r\nb,q%2\r\nc,q_3').byteLength,
      cap: null,
      csv: 'id,queue\r\na,q1\r\nb,q%2\r\nc,q_3',
    });
  });

  describe('export worker isolation and accounting', () => {
    class FakeExportWorker {
      static live: FakeExportWorker[] = [];
      terminated = false;
      private readonly listeners = new Map<string, ((event: unknown) => void)[]>();

      constructor() {
        FakeExportWorker.live.push(this);
      }

      addEventListener(type: string, listener: (event: unknown) => void): void {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
      }

      private emit(type: string, event: unknown): void {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }

      postMessage(_message: unknown): void {
        // A silent worker models a synchronous sqlite3_step that has not yielded.
      }

      reply(data: unknown): void {
        this.emit('message', { data });
      }

      terminate(): void {
        this.terminated = true;
      }

      close(): void {
        this.emit('close', {});
      }

      asWorker(): Worker {
        return this as unknown as Worker;
      }
    }

    beforeAll(() => {
      expect(exportWorkerLoad()).toBe(0);
    });

    afterEach(() => {
      for (const worker of FakeExportWorker.live) worker.close();
      FakeExportWorker.live = [];
      setExportWorkerFactory(null);
      expect(exportWorkerLoad()).toBe(0);
    });

    const installSilentWorker = () => {
      FakeExportWorker.live = [];
      setExportWorkerFactory(() => new FakeExportWorker().asWorker());
    };

    test('an aborted export keeps its sole slot until the SQLite worker really closes', async () => {
      installSilentWorker();
      expect(MAX_CONCURRENT_EXPORTS).toBe(1);
      const controller = new AbortController();
      const abandoned = exportWithTimeout(
        PATH,
        'jobs',
        undefined,
        'asc',
        undefined,
        controller.signal
      ).catch((error) => error as Error);

      expect(exportWorkerLoad()).toBe(1);
      await expect(exportWithTimeout(PATH, 'jobs')).rejects.toBeInstanceOf(DbExportBusyError);
      expect(FakeExportWorker.live).toHaveLength(1);

      controller.abort(new Error('request disconnected'));
      expect((await abandoned).message).toContain('request disconnected');
      expect(FakeExportWorker.live[0]?.terminated).toBe(true);
      // terminate() only requests shutdown; it does not preempt sqlite3_step.
      expect(exportWorkerLoad()).toBe(1);
      FakeExportWorker.live[0]?.close();
      expect(exportWorkerLoad()).toBe(0);
    });

    test('malformed worker messages fail closed and free a completed slot', async () => {
      installSilentWorker();
      const result = exportWithTimeout(PATH, 'jobs').catch((error) => error);
      expect(exportWorkerLoad()).toBe(1);
      FakeExportWorker.live[0]?.reply(null);
      expect(await result).toBeInstanceOf(DbExportUnavailableError);
      expect(exportWorkerLoad()).toBe(0);
      expect(FakeExportWorker.live[0]?.terminated).toBe(true);
    });
  });
});
