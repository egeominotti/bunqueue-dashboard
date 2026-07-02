import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import {
  dbCell,
  dbInfo,
  dbQuery,
  dbRows,
  dbSchema,
  dbTables,
  MAX_ROWS,
  MissingDbError,
} from '../agent/db';

const PATH = `/tmp/bq-agent-db-test-${process.pid}.db`;

beforeAll(() => {
  const db = new Database(PATH);
  db.run('CREATE TABLE jobs (id TEXT PRIMARY KEY, queue TEXT, payload BLOB, score REAL)');
  db.run('CREATE TABLE empty_one (x INTEGER)');
  const ins = db.prepare('INSERT INTO jobs VALUES (?, ?, ?, ?)');
  for (let i = 0; i < 120; i++) {
    ins.run(`job-${String(i).padStart(3, '0')}`, i % 2 ? 'emails' : 'payments', null, i * 1.5);
  }
  // Tables literally named after the sub-resource suffixes — the reader must
  // resolve them by exact name, and the agent's segment routing must reach them.
  db.run('CREATE TABLE "schema" (a INTEGER)');
  db.run('INSERT INTO "schema" VALUES (1)');
  db.run("INSERT INTO jobs VALUES ('blob-row', 'emails', x'deadbeef', 0)");
  // A row with an over-2000-char text payload (in the queue column) for the
  // truncation + full-cell-fetch tests.
  db.run("INSERT INTO jobs VALUES ('big-row', ?, NULL, 0)", 'X'.repeat(5000));
  db.close();
});

afterAll(() => {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${PATH}${suffix}`, { force: true });
});

describe('agent db inspector', () => {
  test('lists user tables with row and column counts', () => {
    const tables = dbTables(PATH);
    const names = tables.map((t) => t.name);
    expect(names).toContain('jobs');
    expect(names).toContain('empty_one');
    const jobs = tables.find((t) => t.name === 'jobs');
    expect(jobs?.rows).toBe(122);
    expect(jobs?.columns).toBe(4);
  });

  test('paginates rows with a real total, rowids, and truncation flags', () => {
    const p0 = dbRows(PATH, 'jobs', 50, 0);
    expect(p0.columns).toEqual(['id', 'queue', 'payload', 'score']);
    expect(p0.rows.length).toBe(50);
    expect(p0.total).toBe(122);
    expect(p0.rowids.length).toBe(50);
    expect(typeof p0.rowids[0]).toBe('number'); // jobs has an implicit rowid
    expect(p0.truncatedCells.length).toBe(50);
    const p2 = dbRows(PATH, 'jobs', 50, 100);
    expect(p2.rows.length).toBe(22);
  });

  test('rejects unknown tables (no identifier injection)', () => {
    expect(() => dbRows(PATH, 'jobs"; DROP TABLE jobs; --', 10, 0)).toThrow('No such table');
    // The attempted name never reached SQL as an identifier — data intact.
    expect(dbTables(PATH).find((t) => t.name === 'jobs')?.rows).toBe(122);
  });

  test('filters rows with a bound value (no injection) and matching total', () => {
    const eq = dbRows(PATH, 'jobs', 50, 0, undefined, 'asc', {
      column: 'queue',
      op: 'eq',
      value: 'emails',
    });
    expect(eq.total).toBe(61);
    expect(eq.filter?.op).toBe('eq');
    expect(eq.rows.every((r) => r[1] === 'emails')).toBe(true);
    // Injection in the value is bound, not interpolated → zero matches, no error.
    const inj = dbRows(PATH, 'jobs', 50, 0, undefined, 'asc', {
      column: 'queue',
      op: 'eq',
      value: "emails' OR '1'='1",
    });
    expect(inj.total).toBe(0);
    // Filter column is allowlisted.
    expect(() =>
      dbRows(PATH, 'jobs', 5, 0, undefined, 'asc', { column: 'nope', op: 'eq', value: 'x' })
    ).toThrow('No such column');
  });

  test('fetches a full untruncated cell by rowid; grid truncates the same value', () => {
    const page = dbRows(PATH, 'jobs', 200, 0);
    const idx = page.rows.findIndex((r) => r[0] === 'big-row');
    expect(idx).toBeGreaterThanOrEqual(0);
    // The grid value is truncated and flagged.
    expect(String(page.rows[idx][1]).endsWith('…')).toBe(true);
    expect(page.truncatedCells[idx][1]).toBe(true);
    // The full-cell fetch returns the whole 5000-char value.
    const rid = page.rowids[idx] as number;
    const full = dbCell(PATH, 'jobs', rid, 'queue');
    expect(String(full.value).length).toBe(5000);
  });

  test('serializes BLOBs as a marker, not a byte object', () => {
    const r = dbQuery(PATH, "SELECT payload FROM jobs WHERE id = 'blob-row'");
    expect(r.rows[0][0]).toBe('<blob 4 B>');
  });

  test('runs SELECT queries and reports timing + truncation', () => {
    const r = dbQuery(PATH, "SELECT id FROM jobs WHERE queue = 'emails' ORDER BY id");
    expect(r.rowCount).toBe(61);
    expect(r.truncated).toBe(false);
    expect(r.columns).toEqual(['id']);
    expect(r.ms).toBeGreaterThanOrEqual(0);
    expect(MAX_ROWS).toBe(500);
  });

  test('write / DDL / ATTACH statements are rejected before execution', () => {
    // Allowlist rejects them up front with a friendly message (not a raw SQLite error).
    expect(() => dbQuery(PATH, "INSERT INTO jobs VALUES ('evil','q',NULL,0)")).toThrow('read-only');
    expect(() => dbQuery(PATH, 'DROP TABLE jobs')).toThrow('read-only');
    expect(() => dbQuery(PATH, "ATTACH DATABASE '/tmp/x.db' AS x")).toThrow('read-only');
    expect(() => dbQuery(PATH, 'CREATE TEMP TABLE t AS SELECT 1')).toThrow('read-only');
    expect(dbTables(PATH).find((t) => t.name === 'jobs')?.rows).toBe(122);
  });

  test('value-less / empty results return {rows:[],rowCount:0}, not an opaque throw', () => {
    const r = dbQuery(PATH, 'PRAGMA user_version');
    expect(r.rowCount).toBe(1); // user_version yields a value
    const empty = dbQuery(PATH, 'SELECT id FROM jobs WHERE 0'); // no matching rows
    expect(empty.rows).toEqual([]);
    expect(empty.rowCount).toBe(0);
  });

  test('streams with an early break at MAX_ROWS instead of materializing everything', () => {
    // A cross join would produce 122*122 = 14884 rows; the cap bounds it to 500.
    const r = dbQuery(PATH, 'SELECT a.id FROM jobs a, jobs b');
    expect(r.rows.length).toBe(MAX_ROWS);
    expect(r.rowCount).toBe(MAX_ROWS);
    expect(r.truncated).toBe(true);
  });

  test('missing database file throws MissingDbError (→ 404)', () => {
    const fn = () => dbTables('/tmp/definitely-missing-bq.db');
    expect(fn).toThrow('Database not found');
    try {
      fn();
    } catch (e) {
      expect(e).toBeInstanceOf(MissingDbError);
    }
  });

  test('sorts server-side by a validated column only', () => {
    const asc = dbRows(PATH, 'jobs', 5, 0, 'score', 'asc');
    const desc = dbRows(PATH, 'jobs', 5, 0, 'score', 'desc');
    expect(asc.orderBy).toBe('score');
    expect(Number(asc.rows[0][3])).toBeLessThan(Number(desc.rows[0][3]));
    // A non-existent column is rejected, not interpolated.
    expect(() => dbRows(PATH, 'jobs', 5, 0, 'score; DROP TABLE jobs')).toThrow('No such column');
  });

  test('resolves a table literally named "schema" by exact name', () => {
    // The reader keys on the exact table name (no suffix-stripping), so a table
    // named "schema" is browsable and its own schema is reachable.
    const rows = dbRows(PATH, 'schema', 10, 0);
    expect(rows.total).toBe(1);
    expect(rows.columns).toEqual(['a']);
    const s = dbSchema(PATH, 'schema');
    expect(s.columns.map((c) => c.name)).toEqual(['a']);
  });

  test('reports schema: columns, PK, indexes, DDL', () => {
    const s = dbSchema(PATH, 'jobs');
    expect(s.columns.map((c) => c.name)).toEqual(['id', 'queue', 'payload', 'score']);
    expect(s.columns[0].primaryKey).toBe(true);
    expect(s.sql).toContain('CREATE TABLE jobs');
    expect(s.rowCount).toBe(122);
  });

  test('reports store metadata', () => {
    const i = dbInfo(PATH);
    expect(i.sqliteVersion).toMatch(/^\d+\.\d+/);
    expect(i.tables).toBe(3);
    expect(i.pageSize).toBeGreaterThan(0);
    expect(i.fileSize).toBeGreaterThan(0);
  });
});
