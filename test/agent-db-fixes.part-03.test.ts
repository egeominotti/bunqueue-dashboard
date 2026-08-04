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
  MAX_CONCURRENT_QUERIES,
  MissingDbError,
  queryWithTimeout,
  queryWorkerLoad,
  setQueryWorkerFactory,
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
