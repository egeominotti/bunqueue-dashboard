/** Hard cap on rows returned by any endpoint. */
export const MAX_ROWS = 500;
/** Cell strings longer than this are truncated server-side. */
export const MAX_CELL = 2000;
/** Full single-cell fetch hard cap. */
export const MAX_FULL_CELL = 1_000_000;
export const DB_EXPORT_MAX_ROWS = 200_000;
export const DB_EXPORT_MAX_BYTES = 16 * 1024 * 1024;
export const DB_EXPORT_MAX_COLUMNS = 256;
export const DB_EXPORT_MAX_IDENTIFIER_CHARS = 1024;
export const DB_EXPORT_MAX_FILTER_CHARS = 4096;
export const DB_EXPORT_TIMEOUT_MS = 15_000;
export const QUERY_TIMEOUT_MS = 5000;
export const MAX_CONCURRENT_QUERIES = 2;
export const MAX_CONCURRENT_EXPORTS = 1;

/** Thrown when the database file does not exist yet (maps to HTTP 404). */
export class MissingDbError extends Error {
  readonly missing = true;
}

/** Maps a saturated export worker pool to HTTP 429. */
export class DbExportBusyError extends Error {}

/** Maps export worker startup/crash/timeout failures to HTTP 503. */
export class DbExportUnavailableError extends Error {}

export interface DbTableInfo {
  name: string;
  rows: number;
  columns: number;
}

export interface DbFilter {
  column: string;
  op: 'contains' | 'eq' | 'ne';
  value: string;
}

export interface DbRowsPage {
  table: string;
  columns: string[];
  rows: unknown[][];
  rowids: (DbRowId | null)[];
  truncatedCells: boolean[][];
  total: number;
  limit: number;
  offset: number;
  orderBy: string | null;
  dir: 'asc' | 'desc';
  filter: DbFilter | null;
}

export type DbExportCap = 'rows' | 'bytes' | null;

export interface DbCsvExport {
  table: string;
  content: Uint8Array<ArrayBuffer>;
  rowCount: number;
  bytes: number;
  cap: DbExportCap;
}

/** Tests may lower a cap, but callers can never raise the production ceiling. */
export interface DbExportLimits {
  maxRows?: number;
  maxBytes?: number;
  onSnapshot?: () => void;
}

export interface DbRowsOptions {
  afterCount?: () => void;
}

/** JSON/query-string-safe SQLite rowid. */
export type DbRowId = number | string;

export interface DbColumnInfo {
  name: string;
  type: string;
  notNull: boolean;
  defaultValue: string | null;
  primaryKey: boolean;
}

export interface DbIndexInfo {
  name: string;
  unique: boolean;
  columns: string[];
}

export interface DbTableSchema {
  table: string;
  columns: DbColumnInfo[];
  indexes: DbIndexInfo[];
  sql: string | null;
  rowCount: number;
}

export interface DbInfo {
  sqliteVersion: string;
  pageSize: number;
  pageCount: number;
  journalMode: string;
  freelistPages: number;
  tables: number;
  indexes: number;
  fileSize: number;
  walSize: number;
}

export interface DbQueryResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  ms: number;
}
