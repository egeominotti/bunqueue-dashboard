import { dbExportCsv } from './csvExport';
import { dbQuery } from './query';
import { dbInfo, dbSchema } from './schema';
import { dbCell, dbRows, dbTables } from './tables';
import { workflowExecution } from '../workflow/detail';
import { workflowExecutions } from '../workflow/list';
import { workflowStats } from '../workflow/stats';

/** Fixed allowlist shared by the typed caller and isolated SQLite process. */
export const READ_OPERATIONS = {
  dbQuery, dbExportCsv, dbInfo, dbSchema, dbCell, dbRows, dbTables,
  workflowExecution, workflowExecutions, workflowStats,
};

export type ReadOperation = keyof typeof READ_OPERATIONS;
export type ReadArguments<K extends ReadOperation> = Parameters<(typeof READ_OPERATIONS)[K]>;
export type ReadResult<K extends ReadOperation> = ReturnType<(typeof READ_OPERATIONS)[K]>;

export function dispatchRead(request: unknown): unknown {
  if (!request || typeof request !== 'object') throw new Error('Invalid database read request');
  const { operation, args } = request as { operation: string; args: unknown[] };
  if (!Object.hasOwn(READ_OPERATIONS, operation) || !Array.isArray(args)) {
    throw new Error('Unknown database read operation');
  }
  const execute = READ_OPERATIONS[operation as ReadOperation] as (...args: unknown[]) => unknown;
  return execute(...args);
}
