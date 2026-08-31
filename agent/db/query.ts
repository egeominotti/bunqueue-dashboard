import type { Database } from 'bun:sqlite';
import { ident, openDb, safeIntegers, sanitize, translateDbError } from './core';
import { MAX_ROWS, type DbQueryResult } from './types';

const READ_ONLY_LEAD = /^(?:SELECT|WITH|EXPLAIN|VALUES|PRAGMA)\b/;
const DUP_VIEW = '__bq_query_columns';

function leadingKeyword(sql: string): string {
  const head = sql.replace(/^(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*/, '');
  return head.slice(0, 12).toUpperCase();
}

/** Let SQLite disambiguate colliding output names through a private TEMP view. */
function disambiguateColumns(
  db: Database,
  sql: string
): { stmt: ReturnType<Database['query']>; cols: string[] } | null {
  try {
    // query().run() compiles one statement; db.run() would execute a trailing
    // statement that the leading-keyword allowlist cannot see.
    db.query(`CREATE TEMP VIEW ${ident(DUP_VIEW)} AS ${sql.replace(/;\s*$/, '')}`).run();
    const columns = (
      db.query(`PRAGMA table_info(${ident(DUP_VIEW)})`).all() as { name: string }[]
    ).map((column) => column.name);
    return { stmt: db.query(`SELECT * FROM ${ident(DUP_VIEW)}`), cols: columns };
  } catch {
    return null;
  }
}

/** Synchronous read-only query implementation used inside a disposable Worker. */
export function dbQuery(path: string, sql: string): DbQueryResult {
  const trimmed = sql.trim();
  if (!trimmed) throw new Error('Empty query');
  if (!READ_ONLY_LEAD.test(leadingKeyword(trimmed))) {
    throw new Error(
      'Only read-only SELECT / WITH / EXPLAIN / VALUES / PRAGMA queries are allowed here.'
    );
  }
  const db = openDb(path);
  try {
    const started = performance.now();
    let statement: ReturnType<Database['query']>;
    try {
      statement = db.query(trimmed);
    } catch (error) {
      throw translateDbError(error);
    }
    let columns = statement.columnNames;
    const hasDuplicateNames = new Set(columns).size !== columns.length;
    if (statement.columnTypes.length > columns.length || hasDuplicateNames) {
      const disambiguated = disambiguateColumns(db, trimmed);
      if (disambiguated) {
        statement = disambiguated.stmt;
        columns = disambiguated.cols;
      }
    }
    safeIntegers(statement);
    const rows: unknown[][] = [];
    let truncated = false;
    try {
      for (const row of statement.iterate() as IterableIterator<Record<string, unknown>>) {
        if (rows.length >= MAX_ROWS) {
          truncated = true;
          break;
        }
        rows.push(columns.map((column) => row[column]));
      }
    } catch (error) {
      throw translateDbError(error);
    }
    const milliseconds = performance.now() - started;
    return {
      columns,
      rows: sanitize(rows),
      rowCount: rows.length,
      truncated,
      ms: Math.round(milliseconds * 10) / 10,
    };
  } finally {
    db.close();
  }
}
