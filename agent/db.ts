/**
 * Read-only SQLite inspector backing the dashboard's Database section.
 *
 * This compatibility entrypoint keeps the original public API stable while the
 * implementations live in focused modules under agent/db/. Every connection is
 * readonly and disposable; arbitrary queries and exports run in bounded workers.
 */
export { dbExportCsv } from './db/csvExport';
export { exportWithTimeout, exportWorkerLoad } from './db/exportTimeout';
export { dbQuery } from './db/query';
export { queryWithTimeout, queryWorkerLoad } from './db/queryTimeout';
export { dbInfo, dbSchema } from './db/schema';
export { dbCell, dbRows, dbTables } from './db/tables';
export {
  setExportWorkerFactory,
  setQueryWorkerFactory,
  setQueryWorkerUrl,
} from './db/workerFactory';
export {
  DB_EXPORT_MAX_BYTES,
  DB_EXPORT_MAX_COLUMNS,
  DB_EXPORT_MAX_FILTER_CHARS,
  DB_EXPORT_MAX_IDENTIFIER_CHARS,
  DB_EXPORT_MAX_ROWS,
  DB_EXPORT_TIMEOUT_MS,
  DbExportBusyError,
  DbExportUnavailableError,
  MAX_CONCURRENT_EXPORTS,
  MAX_CONCURRENT_QUERIES,
  MAX_ROWS,
  MissingDbError,
  QUERY_TIMEOUT_MS,
  type DbColumnInfo,
  type DbCsvExport,
  type DbExportCap,
  type DbExportLimits,
  type DbFilter,
  type DbIndexInfo,
  type DbInfo,
  type DbQueryResult,
  type DbRowId,
  type DbRowsOptions,
  type DbRowsPage,
  type DbTableInfo,
  type DbTableSchema,
} from './db/types';
