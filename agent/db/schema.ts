import { ident, knownTable, openDb } from './core';
import type { DbInfo, DbTableSchema } from './types';

/** Column definitions, indexes and original DDL for one table. */
export function dbSchema(path: string, table: string): DbTableSchema {
  const db = openDb(path);
  try {
    const name = knownTable(db, table);
    const columns = (
      db.query(`PRAGMA table_info(${ident(name)})`).all() as {
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }[]
    ).map((column) => ({
      name: column.name,
      type: column.type || 'ANY',
      notNull: column.notnull === 1,
      defaultValue: column.dflt_value,
      primaryKey: column.pk > 0,
    }));
    const indexes = (
      db.query(`PRAGMA index_list(${ident(name)})`).all() as { name: string; unique: number }[]
    ).map((index) => ({
      name: index.name,
      unique: index.unique === 1,
      columns: (
        db.query(`PRAGMA index_info(${ident(index.name)})`).all() as { name: string }[]
      ).map((column) => column.name),
    }));
    const master = db
      .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) as { sql: string | null } | null;
    const { c: rowCount } = db.query(`SELECT COUNT(*) AS c FROM ${ident(name)}`).get() as {
      c: number;
    };
    return { table: name, columns, indexes, sql: master?.sql ?? null, rowCount };
  } finally {
    db.close();
  }
}

/** Store-level metadata: engine version, pragmas, object counts, on-disk size. */
export function dbInfo(path: string): DbInfo {
  const db = openDb(path);
  try {
    const one = (sql: string) => (db.query(sql).values()[0] as unknown[])[0];
    const count = (type: string) =>
      (
        db
          .query(
            "SELECT COUNT(*) AS c FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%'"
          )
          .get(type) as { c: number }
      ).c;
    const size = (file: string) => {
      try {
        return Bun.file(file).size || 0;
      } catch {
        return 0;
      }
    };
    return {
      sqliteVersion: String(one('SELECT sqlite_version()')),
      pageSize: Number(one('PRAGMA page_size')),
      pageCount: Number(one('PRAGMA page_count')),
      journalMode: String(one('PRAGMA journal_mode')),
      freelistPages: Number(one('PRAGMA freelist_count')),
      tables: count('table'),
      indexes: count('index'),
      fileSize: size(path),
      walSize: size(`${path}-wal`),
    };
  } finally {
    db.close();
  }
}
