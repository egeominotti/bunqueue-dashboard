import { BunqueueBackupRunner, type BackupRunnerPort } from '../backup/runner';
import type { ProcessManager } from '../manager';
import { QueueOperationsRuntime } from '../queue/runtime';
import type { QueueOperationsPort } from '../queue/types';
import { WorkflowRuntime, type WorkflowRuntimePort } from '../workflow/runtime';
import { errorMessage, errorStatus } from './errors';
import { AgentLifecycleGate, type AgentLifecyclePort } from './lifecycle';
import { corsHeaders, isHostAllowed, isOriginAllowed, tokenOk } from './policy';
import { routeAgentRequest } from './router';
import type { AgentFetchHandler, AgentOptions, RouteResponse } from './types';

function responseOf(
  result: RouteResponse | Response | null,
  origin: string | null,
  allowedOrigins: string[]
): Response {
  if (result instanceof Response) return result;
  const routed = result ?? { status: 404, body: { ok: false, error: 'Not found' } };
  return new Response(JSON.stringify(routed.body), {
    status: routed.status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin, allowedOrigins),
    },
  });
}

/** Build a network-independent request handler with persistent SDK resources. */
export function createFetchHandler(
  manager: ProcessManager,
  options: AgentOptions,
  runtime: WorkflowRuntimePort = new WorkflowRuntime(),
  backupRunner: BackupRunnerPort = new BunqueueBackupRunner(),
  queueRuntime: QueueOperationsPort = new QueueOperationsRuntime(),
  lifecycle: AgentLifecyclePort = new AgentLifecycleGate()
): AgentFetchHandler {
  const {
    allowedOrigins,
    allowedHosts,
    token,
    requireTokenForAll = false,
  } = options;
  const json = (body: unknown, status: number, origin: string | null) =>
    responseOf({ body, status }, origin, allowedOrigins);

  const handle = async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    const method = request.method;
    const origin = request.headers.get('origin');
    if (!isHostAllowed(request.headers.get('host'), allowedHosts)) {
      return json({ ok: false, error: 'Host not allowed' }, 403, origin);
    }
    if (!isOriginAllowed(origin, allowedOrigins)) {
      return json({ ok: false, error: 'Origin not allowed' }, 403, origin);
    }
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin, allowedOrigins) });
    }
    const mutating = method === 'POST' || method === 'PUT';
    const authRequired = requireTokenForAll || (mutating && Boolean(token));
    if (authRequired && !tokenOk(request, token)) {
      return json({ ok: false, error: 'Unauthorized' }, 401, origin);
    }

    try {
      lifecycle.assertOpen();
      const result = await routeAgentRequest(
        request,
        pathname,
        method,
        manager,
        runtime,
        backupRunner,
        queueRuntime,
        lifecycle,
        origin,
        allowedOrigins
      );
      return responseOf(result, origin, allowedOrigins);
    } catch (error) {
      return json({ ok: false, error: errorMessage(error) }, errorStatus(error), origin);
    }
  };
  let closing: Promise<void> | null = null;
  const close = () => {
    closing ??= lifecycle.close(() =>
      settleResourceClosures([
        () => runtime.close(),
        () => backupRunner.close(),
        () => queueRuntime.close(),
      ])
    );
    return closing;
  };
  const beginShutdown = () => {
    manager.beginShutdown();
    return close();
  };
  let shuttingDown: Promise<void> | null = null;
  const shutdown = () => {
    shuttingDown ??= closeThenShutdown(beginShutdown, manager);
    return shuttingDown;
  };
  const forceShutdown = () => manager.forceShutdown();
  return Object.assign(handle, { close, beginShutdown, shutdown, forceShutdown });
}

async function closeThenShutdown(
  beginShutdown: () => Promise<void>,
  manager: ProcessManager
): Promise<void> {
  const closeResult = await settle(beginShutdown);
  const shutdownResult = await settle(() => manager.shutdown());
  if (!closeResult.ok && !shutdownResult.ok) {
    throw new AggregateError(
      [closeResult.error, shutdownResult.error],
      'Agent resources and managed server both failed to shut down'
    );
  }
  if (!closeResult.ok) throw closeResult.error;
  if (!shutdownResult.ok) throw shutdownResult.error;
}

async function settleResourceClosures(closures: Array<() => Promise<void>>): Promise<void> {
  const settled = await Promise.allSettled(
    closures.map((closeResource) => Promise.resolve().then(closeResource))
  );
  const failures = settled.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  );
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Multiple agent resources failed to close');
  }
}

type SettledOperation = { ok: true } | { ok: false; error: unknown };

async function settle(operation: () => Promise<unknown>): Promise<SettledOperation> {
  try {
    await operation();
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}
