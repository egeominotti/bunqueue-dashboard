import { openWorkflowDatabase, workflowSchema } from './sqlite';
import {
  WORKFLOW_LIMITS,
  WORKFLOW_STATES,
  type WorkflowExecutionState,
  type WorkflowStats,
} from './types';

export function workflowStats(
  path: string,
  /** @internal Deterministic seam for the SQLite snapshot regression test. */
  afterActiveTotals?: () => void
): WorkflowStats {
  const db = openWorkflowDatabase(path);
  try {
    const active = workflowSchema(db, 'active');
    const archive = workflowSchema(db, 'archive');
    const states = Object.fromEntries(WORKFLOW_STATES.map((state) => [state, 0])) as Record<
      WorkflowExecutionState,
      number
    >;
    if (!active) {
      return { available: false, activeTotal: 0, archiveTotal: 0, states, workflowNames: [] };
    }
    const snapshot = db.transaction((): WorkflowStats => {
      const stateColumns = WORKFLOW_STATES.map(
        (state, index) => `SUM(CASE WHEN state = '${state}' THEN 1 ELSE 0 END) AS state_${index}`
      ).join(', ');
      const totals = db
        .query(`SELECT COUNT(*) AS total, ${stateColumns} FROM workflow_executions`)
        .get() as { total: number } & Record<`state_${number}`, number | null>;
      for (const [index, state] of WORKFLOW_STATES.entries()) {
        states[state] = totals[`state_${index}`] ?? 0;
      }
      if (Object.values(states).reduce((sum, count) => sum + count, 0) !== totals.total) {
        throw new Error('Workflow store contains an unknown execution state');
      }
      afterActiveTotals?.();
      const names = workflowNames(db, Boolean(archive));
      const archiveTotal = archive
        ? ((db.query('SELECT COUNT(*) AS count FROM workflow_executions_archive').get() as { count: number }).count ?? 0)
        : 0;
      return {
        available: true,
        activeTotal: totals.total,
        archiveTotal,
        states,
        workflowNames: names,
      };
    });
    return snapshot.deferred();
  } finally {
    db.close();
  }
}

function workflowNames(db: import('bun:sqlite').Database, hasArchive: boolean): string[] {
  const rows = db
    .query(
      hasArchive
        ? `SELECT workflow_name FROM (
             SELECT workflow_name FROM workflow_executions
             UNION
             SELECT workflow_name FROM workflow_executions_archive
           ) ORDER BY workflow_name LIMIT 500`
        : 'SELECT DISTINCT workflow_name FROM workflow_executions ORDER BY workflow_name LIMIT 500'
    )
    .all() as { workflow_name: unknown }[];
  return rows.map((row) => {
    if (
      typeof row.workflow_name !== 'string' ||
      row.workflow_name.length < 1 ||
      row.workflow_name.length > WORKFLOW_LIMITS.filter
    ) {
      throw new Error('Workflow store contains an invalid workflow name');
    }
    return row.workflow_name;
  });
}
