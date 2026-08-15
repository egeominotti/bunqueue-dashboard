import type { ServerConfig } from '../manager';
import { assertManagedTarget, type ManagedTargetPolicy } from '../managedTarget';
import type {
  ManagedRuntimeAdmission,
  ManagedRuntimeSnapshot,
} from '../server/managedRuntime';
import { assertNoFlowBody, readFlowJsonBody } from './validation';
import {
  createFlow,
  inspectFlowJob,
  mutateFlowJob,
  readParentResults,
  readFlow,
  waitForFlowJob,
} from './service';
import type { FlowInspectOperation, FlowMutationOperation } from './types';

export interface FlowOperationsPort {
  create: typeof createFlow;
  inspect: typeof inspectFlowJob;
  mutate: typeof mutateFlowJob;
  parentResults: typeof readParentResults;
  read: typeof readFlow;
  wait: typeof waitForFlowJob;
}

export interface FlowRouteDependencies {
  admission?: ManagedRuntimeAdmission;
  operations?: FlowOperationsPort;
  targetPolicy?: ManagedTargetPolicy;
}

const DEFAULT_OPERATIONS: FlowOperationsPort = {
  create: createFlow,
  inspect: inspectFlowJob,
  mutate: mutateFlowJob,
  parentResults: readParentResults,
  read: readFlow,
  wait: waitForFlowJob,
};

export interface FlowRouteResponse {
  status: number;
  body: Record<string, unknown>;
}

const INSPECTIONS = new Set<FlowInspectOperation>([
  'getState',
  'isWaiting',
  'isActive',
  'isDelayed',
  'isCompleted',
  'isFailed',
  'isWaitingChildren',
  'toJSON',
  'asJSON',
  'getChildrenValues',
  'getDependencies',
  'getDependenciesCount',
  'getFailedChildrenValues',
  'getIgnoredChildrenFailures',
]);
const MUTATIONS = new Set<FlowMutationOperation>([
  'removeChildDependency',
  'removeUnprocessedChildren',
  'updateData',
  'updateProgress',
  'log',
  'changeDelay',
  'changePriority',
  'clearLogs',
  'removeDeduplicationKey',
  'retry',
  'promote',
  'remove',
]);
const MUTATIONS_WITH_BODY = new Set<FlowMutationOperation>([
  'updateData',
  'updateProgress',
  'log',
  'changeDelay',
  'changePriority',
  'clearLogs',
]);

export async function routeFlowRequest(
  request: Request,
  pathname: string,
  method: string,
  config: ServerConfig,
  serverRunning = true,
  dependencies: FlowRouteDependencies = {}
): Promise<FlowRouteResponse | null> {
  if (isFlowRoute(pathname, method) && !serverRunning) {
    throw new Error('Start the managed Bunqueue server before Flow operations.');
  }
  if (pathname === '/flows/create' && method === 'POST') {
    const query = exactQuery(request.url, ['target']);
    assertManagedTarget(query, config, dependencies.targetPolicy);
    const body = await readFlowJsonBody(request);
    return success(
      await admitted(query, config, serverRunning, dependencies, ({ config: current }) =>
        operations(dependencies).create(current, body)
      )
    );
  }
  if (pathname === '/flows/tree' && method === 'GET') {
    const query = exactQuery(request.url, ['id', 'queueName', 'depth', 'maxChildren', 'target']);
    assertManagedTarget(query, config, dependencies.targetPolicy);
    const target = {
      id: required(query, 'id'),
      queueName: required(query, 'queueName'),
      depth: optionalInteger(query, 'depth'),
      maxChildren: optionalInteger(query, 'maxChildren'),
    };
    return success(
      await admitted(query, config, serverRunning, dependencies, ({ config: current }) =>
        operations(dependencies).read(current, target)
      )
    );
  }
  if (pathname === '/flows/results' && method === 'POST') {
    const query = exactQuery(request.url, ['target']);
    assertManagedTarget(query, config, dependencies.targetPolicy);
    const body = await readFlowJsonBody(request);
    return success(
      await admitted(query, config, serverRunning, dependencies, ({ config: current }) =>
        operations(dependencies).parentResults(current, body)
      )
    );
  }
  const match = pathname.match(/^\/flows\/jobs\/([^/]+)\/([^/]+)$/);
  if (!match) return null;
  const query = exactQuery(
    request.url,
    operationFromPath(pathname) === 'waitUntilFinished'
      ? ['queueName', 'target', 'ttl']
      : ['queueName', 'target']
  );
  assertManagedTarget(query, config, dependencies.targetPolicy);
  const target = { id: decodeURIComponent(match[1]), queueName: required(query, 'queueName') };
  const operation = match[2];
  if (method === 'GET' && operation === 'waitUntilFinished') {
    const ttl = requiredInteger(query, 'ttl', 1, 60_000);
    return success(
      await admitted(query, config, serverRunning, dependencies, ({ config: current }) =>
        operations(dependencies).wait(current, target, ttl)
      )
    );
  }
  if (method === 'GET' && INSPECTIONS.has(operation as FlowInspectOperation)) {
    return success(
      await admitted(query, config, serverRunning, dependencies, ({ config: current }) =>
        operations(dependencies).inspect(current, target, operation as FlowInspectOperation)
      )
    );
  }
  if (method === 'POST' && MUTATIONS.has(operation as FlowMutationOperation)) {
    const mutation = operation as FlowMutationOperation;
    const payload = MUTATIONS_WITH_BODY.has(mutation)
      ? await readFlowJsonBody(request)
      : (assertNoFlowBody(request), {});
    return success(
      await admitted(query, config, serverRunning, dependencies, ({ config: current }) =>
        operations(dependencies).mutate(current, target, mutation, payload)
      )
    );
  }
  return { status: 404, body: { ok: false, error: 'Unknown flow operation' } };
}

function admitted<T>(
  query: URLSearchParams,
  config: ServerConfig,
  running: boolean,
  dependencies: FlowRouteDependencies,
  operation: (snapshot: ManagedRuntimeSnapshot) => Promise<T>
): Promise<T> {
  const execute = async (snapshot: ManagedRuntimeSnapshot) => {
    assertManagedTarget(query, snapshot.config, dependencies.targetPolicy);
    assertRunning(snapshot.running);
    return operation(snapshot);
  };
  return dependencies.admission
    ? dependencies.admission(execute)
    : execute({ config, running });
}

function operations(dependencies: FlowRouteDependencies): FlowOperationsPort {
  return dependencies.operations ?? DEFAULT_OPERATIONS;
}

function assertRunning(running: boolean): void {
  if (!running) throw new Error('Start the managed Bunqueue server before Flow operations.');
}

function isFlowRoute(pathname: string, method: string): boolean {
  if (method === 'GET' && pathname === '/flows/tree') return true;
  if (method === 'POST' && ['/flows/create', '/flows/results'].includes(pathname)) return true;
  return (
    (method === 'GET' || method === 'POST') &&
    /^\/flows\/jobs\/[^/]+\/[^/]+$/.test(pathname)
  );
}

function operationFromPath(pathname: string): string {
  return pathname.slice(pathname.lastIndexOf('/') + 1);
}

function success(value: unknown): FlowRouteResponse {
  return { status: 200, body: { ok: true, result: value } };
}

function exactQuery(url: string, allowed: string[]): URLSearchParams {
  const query = new URL(url).searchParams;
  for (const key of query.keys()) {
    if (!allowed.includes(key)) throw new Error(`Unknown flow option: ${key}`);
    if (query.getAll(key).length !== 1) throw new Error(`Duplicate flow option: ${key}`);
  }
  return query;
}

function required(query: URLSearchParams, key: string): string {
  const value = query.get(key);
  if (!value) throw new Error(`Flow ${key} is required`);
  return value;
}

function optionalInteger(query: URLSearchParams, key: string): number | undefined {
  const raw = query.get(key);
  if (raw === null) return undefined;
  if (!/^\d+$/.test(raw)) throw new Error(`Flow ${key} must be a non-negative integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > 500) throw new Error(`Flow ${key} must be at most 500`);
  return value;
}

function requiredInteger(
  query: URLSearchParams,
  key: string,
  minimum: number,
  maximum: number
): number {
  const raw = required(query, key);
  if (!/^\d+$/.test(raw)) throw new Error(`Flow ${key} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Flow ${key} must be from ${minimum} to ${maximum}`);
  }
  return value;
}
