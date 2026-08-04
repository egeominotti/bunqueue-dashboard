import {
  boundedExportLimit,
  buildFilter,
  ident,
  knownTable,
  openDb,
  safeIntegers,
  translateDbError,
} from './core';
import {
  DB_EXPORT_MAX_BYTES,
  DB_EXPORT_MAX_COLUMNS,
  DB_EXPORT_MAX_FILTER_CHARS,
  DB_EXPORT_MAX_IDENTIFIER_CHARS,
  DB_EXPORT_MAX_ROWS,
  MAX_CELL,
  type DbCsvExport,
  type DbExportCap,
  type DbExportLimits,
  type DbFilter,
} from './types';

function csvCell(value: unknown): string {
  let text: string;
  let textual = false;
  if (value == null) text = '';
  else if (typeof value === 'string') {
    text = value;
    textual = true;
  } else if (
    typeof value === 'bigint' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    text = String(value);
  } else if (value instanceof Uint8Array) {
    text = `<blob ${value.byteLength} B>`;
    textual = true;
  } else {
    throw new Error('Database export produced an unsupported SQLite value');
  }
  const safe = textual && /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

function validateRequest(table: string, dir: string, filter?: DbFilter): void {
  if (typeof table !== 'string' || table.length === 0) throw new Error('Table is required');
  if (table.length > DB_EXPORT_MAX_IDENTIFIER_CHARS) {
    throw new Error(`Table name exceeds ${DB_EXPORT_MAX_IDENTIFIER_CHARS} characters`);
  }
  if (dir !== 'asc' && dir !== 'desc') throw new Error('Invalid export sort direction');
  if (!filter) return;
  if (
    typeof filter.column !== 'string' ||
    !filter.column ||
    !['contains', 'eq', 'ne'].includes(filter.op) ||
    typeof filter.value !== 'string'
  ) {
    throw new Error('Invalid database export filter');
  }
  if (filter.column.length > DB_EXPORT_MAX_IDENTIFIER_CHARS) {
    throw new Error(`Filter column exceeds ${DB_EXPORT_MAX_IDENTIFIER_CHARS} characters`);
  }
  if (filter.value.length > DB_EXPORT_MAX_FILTER_CHARS) {
    throw new Error(`Database export filter exceeds ${DB_EXPORT_MAX_FILTER_CHARS} characters`);
  }
}

/** Export one filtered/sorted table view from a single SQLite snapshot. */
export function dbExportCsv(
  path: string,
  table: string,
  orderBy?: string,
  dir: 'asc' | 'desc' = 'asc',
  filter?: DbFilter,
  limits: Readonly<DbExportLimits> = {}
): DbCsvExport {
  validateRequest(table, dir, filter);
  const maxRows = boundedExportLimit(limits.maxRows, DB_EXPORT_MAX_ROWS, 'Export row limit');
  const maxBytes = boundedExportLimit(limits.maxBytes, DB_EXPORT_MAX_BYTES, 'Export byte limit');
  const db = openDb(path);
  try {
    const snapshot = db.transaction((): DbCsvExport => {
      const name = knownTable(db, table);
      const columns = (
        db.query(`PRAGMA table_info(${ident(name)})`).all() as { name: string }[]
      ).map((column) => column.name);
      if (columns.length === 0) throw new Error(`Table has no exportable columns: ${name}`);
      if (columns.length > DB_EXPORT_MAX_COLUMNS) {
        throw new Error(
          `Table has ${columns.length} columns; database export supports at most ${DB_EXPORT_MAX_COLUMNS}`
        );
      }
      if (columns.some((column) => column.length > DB_EXPORT_MAX_IDENTIFIER_CHARS)) {
        throw new Error(
          `Database export column names must not exceed ${DB_EXPORT_MAX_IDENTIFIER_CHARS} characters`
        );
      }
      limits.onSnapshot?.();

      let order = '';
      if (orderBy !== undefined) {
        if (typeof orderBy !== 'string' || !orderBy) {
          throw new Error('Invalid database export sort column');
        }
        if (orderBy.length > DB_EXPORT_MAX_IDENTIFIER_CHARS) {
          throw new Error(`Sort column exceeds ${DB_EXPORT_MAX_IDENTIFIER_CHARS} characters`);
        }
        const sortColumn = columns.find((column) => column === orderBy);
        if (!sortColumn) throw new Error(`No such column: ${orderBy}`);
        order = ` ORDER BY ${ident(sortColumn)} ${dir === 'desc' ? 'DESC' : 'ASC'}`;
      }
      const { clause, params } = buildFilter(columns, filter);
      const aliases = columns.map((_, index) => `__bq_export_${index}`);
      const selected = columns.map((column, index) => {
        const quoted = ident(column);
        return (
          `CASE WHEN typeof(${quoted}) = 'blob' THEN '<blob ' || length(${quoted}) || ' B>' ` +
          `WHEN typeof(${quoted}) = 'text' AND length(CAST(${quoted} AS BLOB)) > ${MAX_CELL} ` +
          `THEN substr(${quoted}, 1, ${MAX_CELL}) || '…' ` +
          `ELSE ${quoted} END AS ${ident(aliases[index])}`
        );
      });
      const statement = db.query<Record<string, unknown>, Array<string | number>>(
        `SELECT ${selected.join(', ')} FROM ${ident(name)}${clause}${order} LIMIT ?`
      );
      safeIntegers(statement);

      const encoder = new TextEncoder();
      const buffer = new Uint8Array(maxBytes);
      let used = 0;
      const append = (text: string): boolean => {
        const result = encoder.encodeInto(text, buffer.subarray(used));
        if (result.read !== text.length) return false;
        used += result.written;
        return true;
      };
      if (!append(columns.map(csvCell).join(','))) {
        throw new Error(`Database export header exceeds the ${maxBytes}-byte export limit`);
      }

      let rowCount = 0;
      let cap: DbExportCap = null;
      const iterator = statement.iterate(...([...params, maxRows + 1] as Array<string | number>));
      try {
        for (;;) {
          const next = iterator.next();
          if (next.done) break;
          if (rowCount >= maxRows) {
            cap = 'rows';
            break;
          }
          const line = `\r\n${aliases.map((alias) => csvCell(next.value[alias])).join(',')}`;
          if (!append(line)) {
            cap = 'bytes';
            break;
          }
          rowCount++;
        }
      } finally {
        iterator.return?.();
      }
      const content = buffer.slice(0, used);
      return { table: name, content, rowCount, bytes: content.byteLength, cap };
    });
    return snapshot.deferred();
  } catch (error) {
    throw translateDbError(error);
  } finally {
    db.close();
  }
}
