import {
  bigintCell,
  boundRowid,
  buildFilter,
  ident,
  isTruncated,
  knownTable,
  openDb,
  safeIntegers,
  sanitize,
} from './core';
import {
  MAX_FULL_CELL,
  MAX_ROWS,
  type DbFilter,
  type DbRowId,
  type DbRowsOptions,
  type DbRowsPage,
  type DbTableInfo,
} from './types';

/** All user tables with row + column counts. */
export function dbTables(path: string): DbTableInfo[] {
  const db = openDb(path);
  try {
    const tables = db
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all() as { name: string }[];
    return tables.map(({ name }) => {
      const { c } = db.query(`SELECT COUNT(*) AS c FROM ${ident(name)}`).get() as { c: number };
      const columns = db.query(`PRAGMA table_info(${ident(name)})`).all();
      return { name, rows: c, columns: columns.length };
    });
  } finally {
    db.close();
  }
}

/** One page of a table's rows from a single SQLite snapshot. */
export function dbRows(
  path: string,
  table: string,
  limit: number,
  offset: number,
  orderBy?: string,
  dir: 'asc' | 'desc' = 'asc',
  filter?: DbFilter,
  options: Readonly<DbRowsOptions> = {}
): DbRowsPage {
  const boundedLimit = Math.max(1, Math.min(MAX_ROWS, Math.floor(limit) || 50));
  const boundedOffset = Number.isFinite(offset)
    ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(offset) || 0))
    : 0;
  const db = openDb(path);
  try {
    const snapshot = db.transaction((): DbRowsPage => {
      const name = knownTable(db, table);
      const columns = (
        db.query(`PRAGMA table_info(${ident(name)})`).all() as { name: string }[]
      ).map((column) => column.name);

      let order = '';
      let sortColumn: string | null = null;
      if (orderBy) {
        sortColumn = columns.find((column) => column === orderBy) ?? null;
        if (!sortColumn) throw new Error(`No such column: ${orderBy}`);
        order = ` ORDER BY ${ident(sortColumn)} ${dir === 'desc' ? 'DESC' : 'ASC'}`;
      }
      const { clause, params, applied } = buildFilter(columns, filter);
      const { c: total } = db
        .query(`SELECT COUNT(*) AS c FROM ${ident(name)}${clause}`)
        .get(...(params as [])) as { c: number };
      options.afterCount?.();

      let rowids: (DbRowId | null)[] = [];
      let rawRows: unknown[][];
      try {
        const statement = db.query(
          `SELECT rowid AS __rid, * FROM ${ident(name)}${clause}${order} LIMIT ? OFFSET ?`
        );
        safeIntegers(statement);
        const rows = statement.values(...(params as []), boundedLimit, boundedOffset) as unknown[][];
        rowids = rows.map((row) =>
          typeof row[0] === 'bigint'
            ? bigintCell(row[0])
            : typeof row[0] === 'number' && Number.isSafeInteger(row[0])
              ? row[0]
              : null
        );
        rawRows = rows.map((row) => row.slice(1));
      } catch {
        const statement = db.query(
          `SELECT * FROM ${ident(name)}${clause}${order} LIMIT ? OFFSET ?`
        );
        safeIntegers(statement);
        rawRows = statement.values(
          ...(params as []),
          boundedLimit,
          boundedOffset
        ) as unknown[][];
        rowids = rawRows.map(() => null);
      }

      return {
        table: name,
        columns,
        rows: sanitize(rawRows),
        rowids,
        truncatedCells: rawRows.map((row) => row.map(isTruncated)),
        total,
        limit: boundedLimit,
        offset: boundedOffset,
        orderBy: sortColumn,
        dir: dir === 'desc' ? 'desc' : 'asc',
        filter: applied,
      };
    });
    return snapshot.deferred();
  } finally {
    db.close();
  }
}

/** Full, untruncated value of a single cell, keyed by rowid. */
export function dbCell(
  path: string,
  table: string,
  rowid: DbRowId,
  column: string
): { value: unknown } {
  const db = openDb(path);
  try {
    const name = knownTable(db, table);
    const columns = (
      db.query(`PRAGMA table_info(${ident(name)})`).all() as { name: string }[]
    ).map((entry) => entry.name);
    const resolvedColumn = columns.find((entry) => entry === column);
    if (!resolvedColumn) throw new Error(`No such column: ${column}`);
    const statement = db.query(
      `SELECT ${ident(resolvedColumn)} AS v FROM ${ident(name)} WHERE rowid = ?`
    );
    safeIntegers(statement);
    const row = statement.get(boundRowid(rowid)) as { v: unknown } | null;
    if (!row) throw new Error('Row not found');
    let value = row.v;
    if (value instanceof Uint8Array) value = `<blob ${value.byteLength} B — binary, not shown>`;
    else if (typeof value === 'bigint') value = bigintCell(value);
    else if (typeof value === 'string' && value.length > MAX_FULL_CELL) {
      value = `${value.slice(0, MAX_FULL_CELL)}…`;
    }
    return { value };
  } finally {
    db.close();
  }
}
