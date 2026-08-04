/**
 * Read-only observability adapter for Bunqueue 2.8.57's Workflow Engine store.
 *
 * Workflow control belongs to the live `Engine` instance because it owns the
 * registered handlers. The dashboard agent therefore reads persisted state but
 * never writes rows or pretends that a SQLite edit is equivalent to signal(),
 * recover(), resumeCompensation(), or abandonCompensation().
 */
import { existsSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { Unpackr } from 'msgpackr';
import { MissingDbError } from './db';

export const WORKFLOW_STATES = [
  'running',
  'waiting',
  'completed',
  'failed',
  'compensating',
  'compensation-stuck',
] as const;

export type WorkflowExecutionState = (typeof WORKFLOW_STATES)[number];
export type WorkflowStateFilter = WorkflowExecutionState | 'compensation';
export type WorkflowStoreKind = 'active' | 'archive';

const MAX_PAGE = 100;
const MAX_OFFSET = 1_000_000;
const MAX_FILTER = 256;
const MAX_DETAIL_BLOB = 4 * 1024 * 1024;
const MAX_META_BLOB = 256 * 1024;
const MAX_JSON_NODES = 25_000;
const MAX_JSON_DEPTH = 40;
const MAX_STRING = 250_000;

const unpackr = new Unpackr({ structuredClone: true });

interface WorkflowRowBase {
  id: string;
  workflow_name: string;
  state: string;
  current_node_index: number;
  created_at: number;
  updated_at: number;
  archived_at?: number | null;
  meta?: Uint8Array | null;
}

export interface WorkflowExecutionSummary {
  id: string;
  workflowName: string;
  state: WorkflowExecutionState;
  currentNodeIndex: number;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
  rollbackStatus?: string;
  failureReason?: string;
  parentExecutionId?: string;
  definitionHash?: string;
}

export interface WorkflowExecutionDetail extends WorkflowExecutionSummary {
  input: unknown;
  steps: Record<string, unknown>;
  resolvedSteps?: string[];
  signals: Record<string, unknown>;
  decisions?: Record<string, unknown>;
  committedAt?: number;
}

export interface WorkflowStats {
  available: boolean;
  activeTotal: number;
  archiveTotal: number;
  states: Record<WorkflowExecutionState, number>;
  workflowNames: string[];
}

function open(path: string): Database {
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

function tableName(kind: WorkflowStoreKind): string {
  return kind === 'archive' ? 'workflow_executions_archive' : 'workflow_executions';
}

function columns(db: Database, table: string): Set<string> {
  return new Set(
    (db.query(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map((row) => row.name)
  );
}

function hasTable(db: Database, table: string): boolean {
  return Boolean(
    db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
  );
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

function schema(db: Database, kind: WorkflowStoreKind): { table: string; hasMeta: boolean } | null {
  const table = tableName(kind);
  if (!hasTable(db, table)) return null;
  const found = columns(db, table);
  const missing = REQUIRED_COLUMNS.filter((name) => !found.has(name));
  if (kind === 'archive' && !found.has('archived_at')) missing.push('archived_at');
  if (missing.length > 0) {
    throw new Error(`Invalid ${table} schema: missing ${missing.join(', ')}`);
  }
  return { table, hasMeta: found.has('meta') };
}

function validState(value: string): value is WorkflowExecutionState {
  return (WORKFLOW_STATES as readonly string[]).includes(value);
}

function assertRow(row: WorkflowRowBase): WorkflowExecutionSummary {
  if (
    typeof row.id !== 'string' ||
    typeof row.workflow_name !== 'string' ||
    row.workflow_name.length < 1 ||
    row.workflow_name.length > MAX_FILTER ||
    !validState(row.state) ||
    !Number.isSafeInteger(row.current_node_index) ||
    !Number.isFinite(row.created_at) ||
    !Number.isFinite(row.updated_at)
  ) {
    throw new Error('Workflow store contains an invalid execution row');
  }
  const meta = decodeObject(row.meta, MAX_META_BLOB, 'meta');
  return {
    id: row.id,
    workflowName: row.workflow_name,
    state: row.state,
    currentNodeIndex: row.current_node_index,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(typeof row.archived_at === 'number' ? { archivedAt: row.archived_at } : {}),
    ...(typeof meta.rollbackStatus === 'string' ? { rollbackStatus: meta.rollbackStatus } : {}),
    ...(typeof meta.failureReason === 'string' ? { failureReason: meta.failureReason } : {}),
    ...(typeof meta.parentExecutionId === 'string'
      ? { parentExecutionId: meta.parentExecutionId }
      : {}),
    ...(typeof meta.definitionHash === 'string' ? { definitionHash: meta.definitionHash } : {}),
  };
}

const STEP_STATES = new Set(['pending', 'running', 'completed', 'failed']);
const COMPENSATION_STATES = new Set([
  'compensated',
  'compensation-failed',
  'compensation-skipped',
]);

function optionalFinite(record: Record<string, unknown>, key: string): boolean {
  return !Object.hasOwn(record, key) ||
    (typeof record[key] === 'number' && Number.isFinite(record[key]));
}

function optionalInteger(record: Record<string, unknown>, key: string): boolean {
  return !Object.hasOwn(record, key) ||
    (typeof record[key] === 'number' && Number.isSafeInteger(record[key]) && record[key] >= 0);
}

function assertSteps(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Workflow steps must decode to an object');
  }
  for (const [name, candidate] of Object.entries(value)) {
    if (!name || candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('Workflow store contains an invalid step record');
    }
    const step = candidate as Record<string, unknown>;
    if (
      typeof step.status !== 'string' ||
      !STEP_STATES.has(step.status) ||
      (Object.hasOwn(step, 'error') && typeof step.error !== 'string') ||
      (Object.hasOwn(step, 'compensatable') && typeof step.compensatable !== 'boolean') ||
      (Object.hasOwn(step, 'idempotencyKey') && typeof step.idempotencyKey !== 'string') ||
      (Object.hasOwn(step, 'childExecutionId') && typeof step.childExecutionId !== 'string') ||
      !optionalFinite(step, 'startedAt') ||
      !optionalFinite(step, 'completedAt') ||
      !optionalInteger(step, 'attempts') ||
      !optionalInteger(step, 'loopIndex') ||
      !optionalInteger(step, 'occurrence')
    ) {
      throw new Error('Workflow store contains an invalid step record');
    }
    if (Object.hasOwn(step, 'compensation')) {
      const candidateCompensation = step.compensation;
      if (
        candidateCompensation === null ||
        typeof candidateCompensation !== 'object' ||
        Array.isArray(candidateCompensation)
      ) {
        throw new Error('Workflow store contains an invalid compensation record');
      }
      const compensation = candidateCompensation as Record<string, unknown>;
      if (
        typeof compensation.status !== 'string' ||
        !COMPENSATION_STATES.has(compensation.status) ||
        typeof compensation.at !== 'number' ||
        !Number.isFinite(compensation.at) ||
        (Object.hasOwn(compensation, 'error') && typeof compensation.error !== 'string')
      ) {
        throw new Error('Workflow store contains an invalid compensation record');
      }
    }
  }
  return value as Record<string, unknown>;
}

function decode(blob: Uint8Array | null | undefined, cap: number, label: string): unknown {
  if (!blob) return null;
  if (!(blob instanceof Uint8Array)) throw new Error(`Workflow ${label} is not a BLOB`);
  if (blob.byteLength > cap) {
    throw new Error(`Workflow ${label} exceeds the ${cap}-byte inspection limit`);
  }
  try {
    return unpackr.unpack(blob);
  } catch (error) {
    throw new Error(`Could not decode workflow ${label}: ${(error as Error).message}`);
  }
}

function decodeObject(
  blob: Uint8Array | null | undefined,
  cap: number,
  label: string
): Record<string, unknown> {
  const value = decode(blob, cap, label);
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Workflow ${label} must decode to an object`);
  }
  return value as Record<string, unknown>;
}

/** Convert decoded MessagePack extensions to a bounded, JSON-safe value. */
function jsonSafe(value: unknown): unknown {
  let nodes = 0;
  const seen = new WeakSet<object>();
  const visit = (entry: unknown, depth: number): unknown => {
    nodes++;
    if (nodes > MAX_JSON_NODES) throw new Error('Workflow detail exceeds the inspection node limit');
    if (depth > MAX_JSON_DEPTH) throw new Error('Workflow detail exceeds the inspection depth limit');
    if (entry == null || typeof entry === 'boolean' || typeof entry === 'number') return entry;
    if (typeof entry === 'string') {
      if (entry.length > MAX_STRING) throw new Error('Workflow detail contains an oversized string');
      return entry;
    }
    if (typeof entry === 'bigint') return entry.toString();
    if (typeof entry === 'undefined') return null;
    if (typeof entry !== 'object') return String(entry);
    if (seen.has(entry)) throw new Error('Workflow detail contains a cyclic value');
    seen.add(entry);
    try {
      if (entry instanceof Date) return entry.toISOString();
      if (entry instanceof Uint8Array) return `<binary ${entry.byteLength} B>`;
      if (entry instanceof Map) {
        const out = Object.create(null) as Record<string, unknown>;
        for (const [key, item] of entry) out[String(key)] = visit(item, depth + 1);
        return out;
      }
      if (entry instanceof Set) return [...entry].map((item) => visit(item, depth + 1));
      if (Array.isArray(entry)) return entry.map((item) => visit(item, depth + 1));
      const out = Object.create(null) as Record<string, unknown>;
      for (const [key, item] of Object.entries(entry)) out[key] = visit(item, depth + 1);
      return out;
    } finally {
      seen.delete(entry);
    }
  };
  return visit(value, 0);
}

export function workflowStats(
  path: string,
  /** @internal Deterministic concurrency seam used by the SQLite snapshot regression test. */
  afterActiveTotals?: () => void
): WorkflowStats {
  const db = open(path);
  try {
    const active = schema(db, 'active');
    const archive = schema(db, 'archive');
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
      const recognizedTotal = Object.values(states).reduce((sum, count) => sum + count, 0);
      if (recognizedTotal !== totals.total) {
        throw new Error('Workflow store contains an unknown execution state');
      }
      afterActiveTotals?.();
      const names = db
        .query(
          archive
            ? `SELECT workflow_name FROM (
                 SELECT workflow_name FROM workflow_executions
                 UNION
                 SELECT workflow_name FROM workflow_executions_archive
               ) ORDER BY workflow_name LIMIT 500`
            : 'SELECT DISTINCT workflow_name FROM workflow_executions ORDER BY workflow_name LIMIT 500'
        )
        .all() as { workflow_name: unknown }[];
      const workflowNames = names.map((row) => {
        if (
          typeof row.workflow_name !== 'string' ||
          row.workflow_name.length < 1 ||
          row.workflow_name.length > MAX_FILTER
        ) {
          throw new Error(`Workflow store contains an invalid workflow name`);
        }
        return row.workflow_name;
      });
      const archiveTotal = archive
        ? ((db.query('SELECT COUNT(*) AS count FROM workflow_executions_archive').get() as {
            count: number;
          }).count ?? 0)
        : 0;
      return {
        available: true,
        activeTotal: totals.total,
        archiveTotal,
        states,
        workflowNames,
      };
    });
    return snapshot.deferred();
  } finally {
    db.close();
  }
}

export function workflowExecutions(
  path: string,
  options: {
    kind?: WorkflowStoreKind;
    workflowName?: string;
    state?: WorkflowStateFilter;
    limit?: number;
    offset?: number;
  } = {},
  /** @internal Deterministic concurrency seam used by the SQLite snapshot regression test. */
  afterRowsRead?: () => void
): { available: boolean; executions: WorkflowExecutionSummary[]; total: number; limit: number; offset: number } {
  const kind = options.kind ?? 'active';
  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE) {
    throw new Error(`Workflow limit must be an integer between 1 and ${MAX_PAGE}`);
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_OFFSET) {
    throw new Error(`Workflow offset must be an integer between 0 and ${MAX_OFFSET}`);
  }
  if (options.workflowName !== undefined && (!options.workflowName || options.workflowName.length > MAX_FILTER)) {
    throw new Error(`Workflow name must contain 1–${MAX_FILTER} characters`);
  }
  if (options.state !== undefined && options.state !== 'compensation' && !validState(options.state)) {
    throw new Error('Unknown workflow execution state');
  }

  const db = open(path);
  try {
    const info = schema(db, kind);
    if (!info) return { available: false, executions: [], total: 0, limit, offset };
    const where: string[] = [];
    const bindings: (string | number)[] = [];
    if (options.workflowName) {
      where.push('workflow_name = ?');
      bindings.push(options.workflowName);
    }
    if (options.state) {
      if (options.state === 'compensation') {
        where.push("state IN ('compensating', 'compensation-stuck')");
      } else {
        where.push('state = ?');
        bindings.push(options.state);
      }
    }
    const predicate = where.length ? ` WHERE ${where.join(' AND ')}` : '';
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
        .all(...bindings, limit, offset) as WorkflowRowBase[];
      afterRowsRead?.();
      const count = db.query(`SELECT COUNT(*) AS count FROM ${info.table}${predicate}`).get(...bindings) as {
        count: number;
      };
      const executions = rows.map(assertRow);
      db.run('COMMIT');
      transactionOpen = false;
      return { available: true, executions, total: count.count, limit, offset };
    } finally {
      if (transactionOpen) {
        try {
          db.run('ROLLBACK');
        } catch {
          // Preserve the original query/decoding error if SQLite already closed the transaction.
        }
      }
    }
  } finally {
    db.close();
  }
}

export function workflowExecution(
  path: string,
  id: string,
  kind: WorkflowStoreKind = 'active'
): WorkflowExecutionDetail | null {
  if (!id || id.length > 1024) throw new Error('Workflow execution id must contain 1–1024 characters');
  const db = open(path);
  try {
    const info = schema(db, kind);
    if (!info) return null;
    const row = db.query(`SELECT * FROM ${info.table} WHERE id = ?`).get(id) as
      | (WorkflowRowBase & {
          input: Uint8Array | null;
          steps: Uint8Array | null;
          resolved_steps: Uint8Array | null;
          signals: Uint8Array | null;
        })
      | null;
    if (!row) return null;
    const summary = assertRow(row);
    const input = jsonSafe(decode(row.input, MAX_DETAIL_BLOB, 'input'));
    const steps = assertSteps(jsonSafe(decodeObject(row.steps, MAX_DETAIL_BLOB, 'steps')));
    const resolved = jsonSafe(decode(row.resolved_steps, MAX_DETAIL_BLOB, 'resolved steps'));
    const signals = jsonSafe(decodeObject(row.signals, MAX_DETAIL_BLOB, 'signals'));
    const meta = decodeObject(row.meta, MAX_META_BLOB, 'meta');
    if (resolved != null && (!Array.isArray(resolved) || resolved.some((item) => typeof item !== 'string'))) {
      throw new Error('Workflow resolved steps must decode to a string array');
    }
    return {
      ...summary,
      input,
      steps,
      ...(resolved ? { resolvedSteps: resolved as string[] } : {}),
      signals: signals as Record<string, unknown>,
      ...(meta.decisions && typeof meta.decisions === 'object'
        ? { decisions: jsonSafe(meta.decisions) as Record<string, unknown> }
        : {}),
      ...(typeof meta.committedAt === 'number' ? { committedAt: meta.committedAt } : {}),
    };
  } finally {
    db.close();
  }
}
