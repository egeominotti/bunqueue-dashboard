import { openWorkflowDatabase, workflowSchema } from './sqlite';
import {
  WORKFLOW_LIMITS,
  type WorkflowListOptions,
  type WorkflowPage,
  type WorkflowRow,
} from './types';
import { assertWorkflowRow, validWorkflowState } from './validation';

export function workflowExecutions(
  path: string,
  options: WorkflowListOptions = {},
  /** @internal Deterministic seam for the SQLite snapshot regression test. */
  afterRowsRead?: () => void
): WorkflowPage {
  const kind = options.kind ?? 'active';
  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;
  validateListOptions(options, limit, offset);
  const db = openWorkflowDatabase(path);
  try {
    const info = workflowSchema(db, kind);
    if (!info) return { available: false, executions: [], total: 0, limit, offset };
    const { predicate, bindings } = listPredicate(options);
    const archiveColumn = kind === 'archive' ? ', archived_at' : '';
    const metaColumn = info.hasMeta ? ', meta' : '';
    db.run('BEGIN');
    let transactionOpen = true;
    try {
      const rows = db
        .query(
          `SELECT id, workflow_name, state, current_node_index, created_at, updated_at${archiveColumn}${metaColumn}
           FROM ${info.table}${predicate} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
        )
        .all(...bindings, limit, offset) as WorkflowRow[];
      afterRowsRead?.();
      const count = db.query(`SELECT COUNT(*) AS count FROM ${info.table}${predicate}`).get(...bindings) as { count: number };
      const executions = rows.map(assertWorkflowRow);
      db.run('COMMIT');
      transactionOpen = false;
      return { available: true, executions, total: count.count, limit, offset };
    } finally {
      if (transactionOpen) rollbackQuietly(db);
    }
  } finally {
    db.close();
  }
}

function validateListOptions(options: WorkflowListOptions, limit: number, offset: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > WORKFLOW_LIMITS.page) {
    throw new Error(`Workflow limit must be an integer between 1 and ${WORKFLOW_LIMITS.page}`);
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > WORKFLOW_LIMITS.offset) {
    throw new Error(`Workflow offset must be an integer between 0 and ${WORKFLOW_LIMITS.offset}`);
  }
  if (options.workflowName !== undefined && (!options.workflowName || options.workflowName.length > WORKFLOW_LIMITS.filter)) {
    throw new Error(`Workflow name must contain 1–${WORKFLOW_LIMITS.filter} characters`);
  }
  if (options.state !== undefined && options.state !== 'compensation' && !validWorkflowState(options.state)) {
    throw new Error('Unknown workflow execution state');
  }
}

function listPredicate(options: WorkflowListOptions): { predicate: string; bindings: string[] } {
  const where: string[] = [];
  const bindings: string[] = [];
  if (options.workflowName) {
    where.push('workflow_name = ?');
    bindings.push(options.workflowName);
  }
  if (options.state === 'compensation') {
    where.push("state IN ('compensating', 'compensation-stuck')");
  } else if (options.state) {
    where.push('state = ?');
    bindings.push(options.state);
  }
  return { predicate: where.length ? ` WHERE ${where.join(' AND ')}` : '', bindings };
}

function rollbackQuietly(db: import('bun:sqlite').Database): void {
  try {
    db.run('ROLLBACK');
  } catch {
    // Preserve the original query or decoding error if SQLite already closed the transaction.
  }
}
