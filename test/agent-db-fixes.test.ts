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
import { existsSync, rmSync } from 'node:fs';
import {
  DB_EXPORT_MAX_BYTES,
  DB_EXPORT_MAX_ROWS,
  DbExportBusyError,
  DbExportUnavailableError,
  dbCell,
  dbExportCsv,
  dbQuery,
  dbRows,
  exportWithTimeout,
  exportWorkerLoad,
  MAX_CONCURRENT_EXPORTS,
  MAX_CONCURRENT_QUERIES,
  MissingDbError,
  queryWithTimeout,
  queryWorkerLoad,
  setExportWorkerFactory,
  setQueryWorkerFactory,
} from '../agent/db';

const PATH = `/tmp/bq-agent-db-fixes-${process.pid}.db`;

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
  test('keeps every output column when names collide (self-join / SELECT a.id, b.id)', () => {
    const r = dbQuery(
      PATH,
      'SELECT jobs.id, runs.rid AS id FROM jobs JOIN runs ON runs.jid = jobs.id'
    );
    // Two output columns in → two out, positionally faithful (was: ["id"] / [["r1"]]).
    expect(r.columns.length).toBe(2);
    expect(r.rows).toEqual([['a', 'r1']]);
    const dup = dbQuery(PATH, 'SELECT id, id FROM jobs ORDER BY id');
    expect(dup.columns.length).toBe(2);
    expect(dup.rows[0]).toEqual(['a', 'a']);
    // Non-colliding queries keep their real column names untouched.
    expect(dbQuery(PATH, 'SELECT id, queue FROM jobs ORDER BY id').columns).toEqual([
      'id',
      'queue',
    ]);
  });

  test('the dup-column recovery path cannot execute a trailing statement', () => {
    // The collision recovery re-prepares the query as a TEMP VIEW. Built with
    // db.run() it would execute EVERY statement in the string, while the
    // front-door allowlist only inspects the FIRST keyword — turning a readonly
    // connection into an arbitrary-file WRITE (VACUUM INTO) and an arbitrary
    // SQLite READ (ATTACH + redefine the view). db.query() compiles only the
    // first statement, so the payload is inert.
    const written = `/tmp/bq-db-escape-${process.pid}.db`;
    rmSync(written, { force: true });
    // Leading dup columns take the recovery path; the payload rides behind it.
    dbQuery(PATH, `SELECT 1 AS a, 2 AS a; VACUUM INTO '${written}'`);
    expect(existsSync(written)).toBe(false);

    const secrets = `/tmp/bq-db-secrets-${process.pid}.db`;
    rmSync(secrets, { force: true });
    const s = new Database(secrets);
    s.run('CREATE TABLE creds (user TEXT, pass TEXT)');
    s.run("INSERT INTO creds VALUES ('root', 'hunter2')");
    s.close();
    const leak = dbQuery(
      PATH,
      `SELECT 1 AS a, 2 AS a; ATTACH DATABASE '${secrets}' AS leak; ` +
        `DROP VIEW "__bq_query_columns"; ` +
        `CREATE TEMP VIEW "__bq_query_columns" AS SELECT * FROM leak.creds`
    );
    expect(leak.columns).not.toContain('pass');
    expect(JSON.stringify(leak.rows)).not.toContain('hunter2');
    rmSync(secrets, { force: true });
    rmSync(written, { force: true });
  });

  test("'contains' filter treats % and _ as literals, not LIKE wildcards", () => {
    const pct = dbRows(PATH, 'jobs', 50, 0, undefined, 'asc', {
      column: 'queue',
      op: 'contains',
      value: '%',
    });
    expect(pct.total).toBe(1); // was 3 — '%' matched every row
    expect(pct.rows.map((r) => r[1])).toEqual(['q%2']);
    const und = dbRows(PATH, 'jobs', 50, 0, undefined, 'asc', {
      column: 'queue',
      op: 'contains',
      value: 'q_',
    });
    expect(und.total).toBe(1); // was 3 — '_' matched any single character
    expect(und.rows.map((r) => r[1])).toEqual(['q_3']);
    // Ordinary substrings still match.
    expect(
      dbRows(PATH, 'jobs', 50, 0, undefined, 'asc', { column: 'queue', op: 'contains', value: 'q' })
        .total
    ).toBe(3);
  });

  test('INTEGERs beyond 2^53 survive the grid, the query runner and the full-cell fetch', () => {
    const page = dbRows(PATH, 'bignum', 10, 0);
    expect(page.rows[0][0]).toBe('9007199254740993'); // was the rounded number 9007199254740992
    expect(page.rows[0][1]).toBe(42); // small ints keep the familiar number shape
    expect(typeof page.rowids[0]).toBe('number'); // rowid still usable for the cell fetch
    expect(dbQuery(PATH, 'SELECT v FROM bignum').rows[0][0]).toBe('9007199254740993');
    expect(dbCell(PATH, 'bignum', page.rowids[0] as number, 'v').value).toBe('9007199254740993');
    expect(dbCell(PATH, 'bignum', page.rowids[0] as number, 'small').value).toBe(42);
  });

  test('rowids beyond 2^53 serialize and bind as exact decimal strings', () => {
    const page = dbRows(PATH, 'huge_rowid', 10, 0);
    expect(page.rowids).toEqual(['9007199254740993']);
    expect(dbCell(PATH, page.table, page.rowids[0] as string, 'payload').value).toBe('exact-row');
    expect(() => dbCell(PATH, page.table, '9007199254740992', 'payload')).toThrow('Row not found');
    expect(() => dbCell(PATH, page.table, '1 OR 1=1', 'payload')).toThrow('Invalid rowid');
  });

  test('non-finite / out-of-range offsets are clamped instead of hitting SQLite', () => {
    // Both threw a raw 'datatype mismatch' (→ HTTP 400) before the clamp.
    expect(dbRows(PATH, 'jobs', 10, Number.POSITIVE_INFINITY).offset).toBe(0);
    expect(dbRows(PATH, 'jobs', 10, 1e20).rows.length).toBe(0);
    expect(dbRows(PATH, 'jobs', 10, Number.NaN).offset).toBe(0);
    expect(dbRows(PATH, 'jobs', 10, -5).offset).toBe(0);
    expect(dbRows(PATH, 'jobs', 10, 1).offset).toBe(1);
  });

  test('CSV export enforces row and byte caps without emitting a partial row', () => {
    expect(DB_EXPORT_MAX_ROWS).toBe(200_000);
    expect(DB_EXPORT_MAX_BYTES).toBe(16 * 1024 * 1024);

    const byRows = dbExportCsv(PATH, 'csv_caps', 'v', 'asc', undefined, { maxRows: 1 });
    expect(byRows.rowCount).toBe(1);
    expect(byRows.cap).toBe('rows');
    expect(new TextDecoder().decode(byRows.content)).toBe("v\r\n'=2+2");

    // Header (1 byte) + first sorted row (7 bytes). The next row cannot fit;
    // the exporter discards it completely rather than cutting a CSV record.
    const byBytes = dbExportCsv(PATH, 'csv_caps', 'v', 'asc', undefined, { maxBytes: 8 });
    expect(byBytes.rowCount).toBe(1);
    expect(byBytes.bytes).toBe(8);
    expect(byBytes.cap).toBe('bytes');
    expect(new TextDecoder().decode(byBytes.content)).toBe("v\r\n'=2+2");
  });

  test('CSV export enforces the production row and byte ceilings', () => {
    const capPath = `/tmp/bq-agent-db-export-caps-${process.pid}.db`;
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${capPath}${suffix}`, { force: true });
    try {
      const setup = new Database(capPath);
      setup.run('CREATE TABLE many_rows (v INTEGER)');
      setup.run(
        'WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v + 1 FROM n WHERE v < 200001) INSERT INTO many_rows SELECT v FROM n'
      );
      setup.run('CREATE TABLE wide_rows (v TEXT)');
      setup.run(
        "WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v + 1 FROM n WHERE v < 9000) INSERT INTO wide_rows SELECT printf('%02000d', v) FROM n"
      );
      setup.close();

      const rows = dbExportCsv(capPath, 'many_rows');
      expect(rows.rowCount).toBe(DB_EXPORT_MAX_ROWS);
      expect(rows.cap).toBe('rows');
      expect(rows.bytes).toBeLessThan(DB_EXPORT_MAX_BYTES);

      const bytes = dbExportCsv(capPath, 'wide_rows');
      expect(bytes.cap).toBe('bytes');
      expect(bytes.rowCount).toBeGreaterThan(0);
      expect(bytes.rowCount).toBeLessThan(9000);
      expect(bytes.bytes).toBeLessThanOrEqual(DB_EXPORT_MAX_BYTES);
      // The only unused budget is smaller than the next complete 2002-byte row.
      expect(DB_EXPORT_MAX_BYTES - bytes.bytes).toBeLessThan(2002);
      expect(bytes.content.byteLength).toBe(bytes.bytes);
    } finally {
      for (const suffix of ['', '-wal', '-shm']) {
        rmSync(`${capPath}${suffix}`, { force: true });
      }
    }
  });

  test('CSV export stays on one point-in-time snapshot while a WAL writer commits', () => {
    const atomicPath = `/tmp/bq-agent-db-export-atomic-${process.pid}.db`;
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${atomicPath}${suffix}`, { force: true });
    try {
      const setup = new Database(atomicPath);
      setup.run('PRAGMA journal_mode = WAL');
      setup.run('CREATE TABLE items (id TEXT PRIMARY KEY)');
      setup.run("INSERT INTO items VALUES ('before')");
      setup.close();

      let writerCommitted = false;
      const exported = dbExportCsv(atomicPath, 'items', 'id', 'asc', undefined, {
        onSnapshot: () => {
          // The hook runs after sqlite_master/table_info have performed the
          // transaction's first read. A separate PROCESS commits in WAL mode
          // while that read transaction remains open. Without the transaction,
          // the SELECT that follows would include this newly committed row.
          const writer = Bun.spawnSync({
            cmd: [
              process.execPath,
              '-e',
              "import { Database } from 'bun:sqlite'; const db = new Database(process.env.BQ_EXPORT_ATOMIC_PATH); db.run('PRAGMA busy_timeout = 2000'); db.run(\"INSERT INTO items VALUES ('during')\"); db.close();",
            ],
            env: { ...process.env, BQ_EXPORT_ATOMIC_PATH: atomicPath },
            stdout: 'pipe',
            stderr: 'pipe',
          });
          if (writer.exitCode !== 0) {
            throw new Error(`Concurrent writer failed: ${writer.stderr.toString()}`);
          }
          writerCommitted = true;
        },
      });

      expect(writerCommitted).toBe(true);
      expect(new TextDecoder().decode(exported.content)).toBe('id\r\nbefore');
      const after = new Database(atomicPath, { readonly: true });
      expect((after.query('SELECT COUNT(*) AS c FROM items').get() as { c: number }).c).toBe(2);
      after.close();
    } finally {
      for (const suffix of ['', '-wal', '-shm']) {
        rmSync(`${atomicPath}${suffix}`, { force: true });
      }
    }
  });

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

  // The worker-boundary behaviours below drive queryWithTimeout through a
  // stand-in worker (setQueryWorkerFactory) rather than a real thread: `bun
  // test` runs every file in ONE process, the DOM-based suites install
  // happy-dom's globals first, and spawning a real Bun Worker after that aborts
  // the allocator. The stand-in speaks the exact protocol dbQueryWorker.ts
  // speaks — {ok:true,result} / {ok:false,error,missing} — so what is under
  // test is db.ts's side of it: slot accounting, the cap, and rebuilding the
  // MissingDbError class from the `missing` flag.
  describe('query worker accounting', () => {
    /** Scripted stand-in for dbQueryWorker.ts. `reply` decides what it posts back. */
    class FakeWorker {
      static live: FakeWorker[] = [];
      terminated = false;
      private readonly listeners = new Map<string, ((ev: unknown) => void)[]>();
      constructor(private readonly reply: (sql: string) => unknown | null) {
        FakeWorker.live.push(this);
      }
      addEventListener(type: string, fn: (ev: unknown) => void): void {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
      }
      private emit(type: string, ev: unknown): void {
        for (const fn of this.listeners.get(type) ?? []) fn(ev);
      }
      postMessage(msg: unknown): void {
        const data = this.reply((msg as { sql: string }).sql);
        // null = a query that never answers (the runaway-scan case).
        if (data !== null) queueMicrotask(() => this.emit('message', { data }));
      }
      terminate(): void {
        this.terminated = true;
      }
      /** What Bun fires when the thread really exits — only then is the slot freed. */
      close(): void {
        this.emit('close', {});
      }
      asWorker(): Worker {
        return this as unknown as Worker;
      }
    }

    const install = (reply: (sql: string) => unknown | null) => {
      FakeWorker.live = [];
      setQueryWorkerFactory(() => new FakeWorker(reply).asWorker());
    };

    // A stand-in that never answers holds its slot by design, so release every
    // one before the next case — the cap is module-global state.
    afterEach(() => {
      for (const w of FakeWorker.live) w.close();
      FakeWorker.live = [];
      setQueryWorkerFactory(null);
      expect(queryWorkerLoad()).toBe(0);
    });

    test('a missing database keeps its class across the worker boundary (→ 404, not 400)', async () => {
      // dbQueryWorker.ts flags MissingDbError because postMessage can't carry a
      // class; db.ts must rebuild it, or server.ts answers 400 where every other
      // /db/* route answers 404.
      install(() => ({ ok: false, error: 'Database not found: /nope.db', missing: true }));
      let caught: unknown;
      try {
        await queryWithTimeout('/nope.db', 'SELECT 1');
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(MissingDbError);
      expect((caught as Error).message).toContain('Database not found');
    });

    test('a plain worker error stays a plain Error (→ 400)', async () => {
      install(() => ({ ok: false, error: 'no such table: nope' }));
      const caught = await queryWithTimeout(PATH, 'SELECT 1').catch((e) => e);
      expect(caught).toBeInstanceOf(Error);
      expect(caught).not.toBeInstanceOf(MissingDbError);
    });

    test('caps concurrent query workers instead of spawning one thread per request', async () => {
      // A query that never answers models the runaway scan terminate() can't kill.
      install(() => null);
      expect(MAX_CONCURRENT_QUERIES).toBe(2);
      expect(queryWorkerLoad()).toBe(0);
      // Each call claims its slot synchronously, before its first await.
      const a = queryWithTimeout(PATH, 'SELECT 1').catch(() => null);
      const b = queryWithTimeout(PATH, 'SELECT 2').catch(() => null);
      expect(queryWorkerLoad()).toBe(MAX_CONCURRENT_QUERIES);
      // Third request is refused rather than pinning a third core.
      await expect(queryWithTimeout(PATH, 'SELECT 3')).rejects.toThrow('Too many queries running');
      expect(FakeWorker.live.length).toBe(MAX_CONCURRENT_QUERIES);
      await Promise.all([a, b]);
    }, 20_000);

    test('a timed-out query keeps holding its slot until its thread really exits', async () => {
      install(() => null);
      const abandoned = queryWithTimeout(PATH, 'SELECT 1').catch((e) => (e as Error).message);
      expect(queryWorkerLoad()).toBe(1);
      expect(await abandoned).toContain('time limit');
      // The client gave up, but the thread is still burning — still accounted for.
      expect(queryWorkerLoad()).toBe(1);
      expect(FakeWorker.live[0]?.terminated).toBe(true);
      // …and freed only when SQLite finally returns and the thread closes.
      FakeWorker.live[0]?.close();
      expect(queryWorkerLoad()).toBe(0);
    }, 20_000);

    test('a query that answers frees its slot immediately', async () => {
      install(() => ({ ok: true, result: { columns: ['x'], rows: [[1]], truncated: false } }));
      expect(queryWorkerLoad()).toBe(0);
      const r = await queryWithTimeout(PATH, 'SELECT 1 AS x');
      expect(r.rows).toEqual([[1]]);
      expect(queryWorkerLoad()).toBe(0);
    });
  });
});
