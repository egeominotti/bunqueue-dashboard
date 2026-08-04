import { decodeWorkflowObject, decodeWorkflowValue, jsonSafeWorkflowValue } from './codec';
import { openWorkflowDatabase, workflowSchema } from './sqlite';
import {
  WORKFLOW_LIMITS,
  type WorkflowExecutionDetail,
  type WorkflowRow,
  type WorkflowStoreKind,
} from './types';
import { assertWorkflowRow, assertWorkflowSteps } from './validation';

interface WorkflowDetailRow extends WorkflowRow {
  input: Uint8Array | null;
  steps: Uint8Array | null;
  resolved_steps: Uint8Array | null;
  signals: Uint8Array | null;
}

export function workflowExecution(
  path: string,
  id: string,
  kind: WorkflowStoreKind = 'active'
): WorkflowExecutionDetail | null {
  if (!id || id.length > 1024) throw new Error('Workflow execution id must contain 1–1024 characters');
  const db = openWorkflowDatabase(path);
  try {
    const info = workflowSchema(db, kind);
    if (!info) return null;
    const row = db.query(`SELECT * FROM ${info.table} WHERE id = ?`).get(id) as WorkflowDetailRow | null;
    if (!row) return null;
    const summary = assertWorkflowRow(row);
    const input = safeDecode(row.input, 'input');
    const steps = assertWorkflowSteps(safeObject(row.steps, 'steps'));
    const resolved = safeDecode(row.resolved_steps, 'resolved steps');
    const signals = safeObject(row.signals, 'signals');
    const meta = decodeWorkflowObject(row.meta, WORKFLOW_LIMITS.metaBlob, 'meta');
    if (resolved != null && (!Array.isArray(resolved) || resolved.some((item) => typeof item !== 'string'))) {
      throw new Error('Workflow resolved steps must decode to a string array');
    }
    return {
      ...summary,
      input,
      steps,
      ...(resolved ? { resolvedSteps: resolved as string[] } : {}),
      signals,
      ...(meta.decisions && typeof meta.decisions === 'object'
        ? { decisions: jsonSafeWorkflowValue(meta.decisions) as Record<string, unknown> }
        : {}),
      ...(typeof meta.committedAt === 'number' ? { committedAt: meta.committedAt } : {}),
    };
  } finally {
    db.close();
  }
}

function safeDecode(blob: Uint8Array | null, label: string): unknown {
  return jsonSafeWorkflowValue(decodeWorkflowValue(blob, WORKFLOW_LIMITS.detailBlob, label));
}

function safeObject(blob: Uint8Array | null, label: string): Record<string, unknown> {
  return jsonSafeWorkflowValue(
    decodeWorkflowObject(blob, WORKFLOW_LIMITS.detailBlob, label)
  ) as Record<string, unknown>;
}
