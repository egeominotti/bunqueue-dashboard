import type { ExecutionState } from 'bunqueue/workflow';
import { assertManagedTarget } from '../managedTarget';
import type { ServerConfig } from '../manager';
import { readLimitedJsonBody } from '../server/jsonBody';
import type {
  ManagedRuntimeAdmission,
  ManagedRuntimeSnapshot,
} from '../server/managedRuntime';
import type { WorkflowRuntimePort } from './runtime';

const MAX_WORKFLOW_BODY_BYTES = 1024 * 1024;

export interface WorkflowRuntimeRouteResponse {
  status: number;
  body: Record<string, unknown>;
}

const TERMINAL_STATES = new Set<ExecutionState>(['completed', 'failed']);

export async function routeWorkflowRuntimeRequest(
  request: Request,
  pathname: string,
  method: string,
  config: ServerConfig,
  runtime: WorkflowRuntimePort,
  serverRunning: boolean,
  admission?: ManagedRuntimeAdmission
): Promise<WorkflowRuntimeRouteResponse | null> {
  if (!isRuntimePath(pathname, method)) return null;
  const query = exactTargetQuery(request.url);
  assertManagedTarget(query, config);
  const admitted = <T>(
    requiresRunning: boolean,
    operation: (snapshot: ManagedRuntimeSnapshot) => Promise<T>
  ): Promise<T> => {
    const execute = async (snapshot: ManagedRuntimeSnapshot) => {
      assertManagedTarget(query, snapshot.config);
      if (requiresRunning && !snapshot.running) {
        throw new Error('Start the managed Bunqueue server before workflow control.');
      }
      return operation(snapshot);
    };
    return admission ? admission(execute) : execute({ config, running: serverRunning });
  };
  if (pathname === '/workflows/runtime' && method === 'GET') {
    return success(
      await admitted(false, ({ config: current, running }) => runtime.status(current, running))
    );
  }
  if (!serverRunning) throw new Error('Start the managed Bunqueue server before workflow control.');
  if (pathname === '/workflows/runtime/reload') {
    return success(await admitted(true, ({ config: current }) => runtime.reload(current)));
  }
  if (pathname === '/workflows/start') {
    const body = record(await workflowBody(request), ['workflowName', 'input']);
    const workflowName = bounded(body.workflowName, 'workflowName', 256);
    return success({
      run: await admitted(true, ({ config: current }) =>
        runtime.start(current, workflowName, body.input)
      ),
    });
  }
  if (pathname === '/workflows/recover') {
    return success({
      recovered: await admitted(true, ({ config: current }) => runtime.recover(current)),
    });
  }
  if (pathname === '/workflows/archive' || pathname === '/workflows/cleanup') {
    const body = record(await workflowBody(request), ['maxAgeMs', 'states']);
    const maxAgeMs = boundedAge(body.maxAgeMs);
    const states = terminalStates(body.states);
    const affected = await admitted(true, ({ config: current }) =>
      pathname === '/workflows/archive'
        ? runtime.archive(current, maxAgeMs, states)
        : runtime.cleanup(current, maxAgeMs, states)
    );
    return success({ affected });
  }
  const match = pathname.match(/^\/workflows\/([^/]+)\/(signal|resume-compensation|abandon-compensation)$/);
  if (!match) return null;
  const id = bounded(decodeURIComponent(match[1]), 'executionId', 1024);
  if (match[2] === 'signal') {
    const body = record(await workflowBody(request), ['event', 'payload']);
    const event = bounded(body.event, 'event', 256);
    await admitted(true, ({ config: current }) =>
      runtime.signal(current, id, event, body.payload)
    );
  } else if (match[2] === 'resume-compensation') {
    await admitted(true, ({ config: current }) => runtime.resumeCompensation(current, id));
  } else {
    await admitted(true, ({ config: current }) => runtime.abandonCompensation(current, id));
  }
  return success({ applied: true });
}

function isRuntimePath(pathname: string, method: string): boolean {
  if (method === 'GET') return pathname === '/workflows/runtime';
  if (method !== 'POST') return false;
  return (
    ['/workflows/runtime/reload', '/workflows/start', '/workflows/recover', '/workflows/archive', '/workflows/cleanup'].includes(pathname) ||
    /^\/workflows\/[^/]+\/(signal|resume-compensation|abandon-compensation)$/.test(pathname)
  );
}

function exactTargetQuery(url: string): URLSearchParams {
  const query = new URL(url).searchParams;
  for (const key of query.keys()) {
    if (key !== 'target') throw new Error(`Unknown workflow control option: ${key}`);
    if (query.getAll(key).length !== 1) throw new Error(`Duplicate workflow control option: ${key}`);
  }
  return query;
}

function success(value: unknown): WorkflowRuntimeRouteResponse {
  return { status: 200, body: { ok: true, result: value } };
}

function record(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Workflow control body must be an object');
  }
  const body = value as Record<string, unknown>;
  const unknown = Object.keys(body).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`Unknown workflow control option: ${unknown}`);
  return body;
}

function workflowBody(request: Request): Promise<unknown> {
  return readLimitedJsonBody(request, {
    scope: 'Workflow control',
    maxBytes: MAX_WORKFLOW_BODY_BYTES,
    limitLabel: '1 MiB',
  });
}

function bounded(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) {
    throw new Error(`Workflow ${label} must contain 1–${maximum} characters`);
  }
  return value;
}

function boundedAge(value: unknown): number {
  const tenYears = 10 * 365 * 24 * 60 * 60 * 1_000;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > tenYears) {
    throw new Error('Workflow maxAgeMs must be an integer between 0 and ten years');
  }
  return value as number;
}

function terminalStates(value: unknown): ExecutionState[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > TERMINAL_STATES.size) {
    throw new Error('Workflow maintenance states must contain completed and/or failed');
  }
  const states = value.map((state) => {
    if (!TERMINAL_STATES.has(state as ExecutionState)) {
      throw new Error('Workflow maintenance accepts only terminal completed/failed states');
    }
    return state as ExecutionState;
  });
  return Array.from(new Set(states));
}
