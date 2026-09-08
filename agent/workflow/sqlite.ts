import { existsSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { MissingDbError } from '../db/types';
import type { WorkflowStoreKind } from './types';

export interface WorkflowSchema {
  table: string;
  hasMeta: boolean;
}

const REQUIRED_COLUMNS = [
  'id',
  'workflow_name',
  'state',
  'input',
  'steps',
  'current_node_index',
  'resolved_steps',
  'signals',
  'created_at',
  'updated_at',
];

export function openWorkflowDatabase(path: string): Database {
  if (!existsSync(path)) {
    throw new MissingDbError(
      `Database not found at "${path}" — configure the Workflow Engine dataPath and start it once.`
    );
  }
  try {
    return new Database(path, { readonly: true });
  } catch (error) {
    throw new Error(`Could not open workflow database: ${(error as Error).message}`);
  }
}

export function workflowSchema(
  db: Database,
  kind: WorkflowStoreKind
): WorkflowSchema | null {
  const table = kind === 'archive' ? 'workflow_executions_archive' : 'workflow_executions';
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) {
    return null;
  }
  const found = new Set(
    (db.query(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map((row) => row.name)
  );
  const missing = REQUIRED_COLUMNS.filter((name) => !found.has(name));
  if (kind === 'archive' && !found.has('archived_at')) missing.push('archived_at');
  if (missing.length > 0) throw new Error(`Invalid ${table} schema: missing ${missing.join(', ')}`);
  return { table, hasMeta: found.has('meta') };
}
