import {
  type WorkflowStateFilter,
  type WorkflowStoreKind,
  workflowExecution,
  workflowExecutions,
  workflowStats,
  WORKFLOW_STATES,
} from '../workflows';
import type { RouteResponse } from './types';
import type { ManagedDatabaseAdmission } from './managedRuntime';

function workflowKind(query: URLSearchParams): WorkflowStoreKind {
  const kind = query.get('kind') ?? 'active';
  if (kind !== 'active' && kind !== 'archive') {
    throw new Error('Workflow kind must be "active" or "archive"');
  }
  return kind;
}

function integer(query: URLSearchParams, name: 'limit' | 'offset', fallback: number): number {
  const raw = query.get(name);
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`Workflow ${name} must be an integer`);
  return Number(raw);
}

export async function routeWorkflowReadRequest(
  request: Request,
  pathname: string,
  method: string,
  dataPath: string,
  admission?: ManagedDatabaseAdmission
): Promise<RouteResponse | null> {
  if (pathname === '/workflows/stats' && method === 'GET') {
    return withDatabase(dataPath, admission, (path) => ({
      status: 200,
      body: { ok: true, ...workflowStats(path) },
    }));
  }
  if (pathname === '/workflows' && method === 'GET') {
    const query = new URL(request.url).searchParams;
    const allowed = new Set(['kind', 'workflowName', 'state', 'limit', 'offset']);
    for (const key of query.keys()) {
      if (!allowed.has(key)) throw new Error(`Unknown workflow option: ${key}`);
      if (query.getAll(key).length !== 1) throw new Error(`Duplicate workflow option: ${key}`);
    }
    const state = query.get('state') || undefined;
    if (
      state &&
      state !== 'compensation' &&
      !(WORKFLOW_STATES as readonly string[]).includes(state)
    ) {
      throw new Error('Unknown workflow execution state');
    }
    return withDatabase(dataPath, admission, (path) => ({
      status: 200,
      body: {
        ok: true,
        ...workflowExecutions(path, {
          kind: workflowKind(query),
          workflowName: query.get('workflowName') || undefined,
          state: state as WorkflowStateFilter | undefined,
          limit: integer(query, 'limit', 50),
          offset: integer(query, 'offset', 0),
        }),
      },
    }));
  }
  if (!pathname.startsWith('/workflows/') || method !== 'GET') return null;
  const rawId = pathname.slice('/workflows/'.length);
  if (!rawId || rawId.includes('/')) {
    return { status: 404, body: { ok: false, error: 'Not found' } };
  }
  const query = new URL(request.url).searchParams;
  for (const key of query.keys()) {
    if (key !== 'kind') throw new Error(`Unknown workflow detail option: ${key}`);
    if (query.getAll(key).length !== 1) {
      throw new Error(`Duplicate workflow detail option: ${key}`);
    }
  }
  return withDatabase(dataPath, admission, (path) => {
    const execution = workflowExecution(path, decodeURIComponent(rawId), workflowKind(query));
    return execution
      ? { status: 200, body: { ok: true, execution } }
      : { status: 404, body: { ok: false, error: 'Workflow execution not found' } };
  });
}

function withDatabase<T>(
  dataPath: string,
  admission: ManagedDatabaseAdmission | undefined,
  operation: (path: string) => T
): Promise<T> {
  return admission
    ? admission((snapshot) => operation(snapshot.dataPath))
    : Promise.resolve(operation(dataPath));
}
