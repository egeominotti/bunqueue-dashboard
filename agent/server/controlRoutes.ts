import { managedStorageMode, type ProcessManager, validateConfigPatch } from '../manager';
import { safeErrorMessage } from '../errorMessage';
import {
  WorkflowRuntimeUnavailableError,
  type WorkflowRuntimePort,
} from '../workflow/runtime';
import { readLimitedJsonBody } from './jsonBody';
import {
  MANAGED_CONTROL_TARGET,
  probeExternalHealth,
  type ServerControlTarget,
} from './controlTarget';
import type { AgentLifecyclePort } from './lifecycle';
import type { RouteResponse } from './types';

const MAX_CONFIG_BODY_BYTES = 64 * 1024;

async function statusWithHealth(
  manager: ProcessManager,
  controlTarget: ServerControlTarget,
  retryOnProcessChange = true
) {
  const snapshot = manager.getStatus();
  const configRevision = snapshot.configRevision ?? manager.getConfigRevision?.() ?? 0;
  if (controlTarget.mode === 'external') {
    const health = await probeExternalHealth(controlTarget);
    return {
      ...snapshot,
      configRevision,
      managementMode: 'external' as const,
      healthy: health.healthy,
      version: health.version,
      reachable: health.reachable,
      externalUrl: controlTarget.url,
      healthStatus: health.statusCode,
      healthError: health.error,
      db: null,
    };
  }
  let healthy = false;
  let version: string | undefined;
  if (snapshot.status === 'running') {
    const port = snapshot.runningConfig?.httpPort ?? snapshot.config.httpPort;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1500),
      });
      if (response.ok) {
        const body: unknown = await response.json();
        if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
          const health = body as Record<string, unknown>;
          healthy = health.ok === true;
          if (typeof health.version === 'string') version = health.version;
        }
      }
    } catch {
      // The managed process is not healthy yet.
    }
  }
  const effectiveConfig = snapshot.runningConfig ?? snapshot.config;
  const database = await statusDatabase(manager, effectiveConfig);
  const current = manager.getStatus();
  if (!sameProcessSnapshot(snapshot, current)) {
    if (retryOnProcessChange) return statusWithHealth(manager, controlTarget, false);
    const currentConfig = current.runningConfig ?? current.config;
    return {
      ...current,
      configRevision: current.configRevision ?? manager.getConfigRevision?.() ?? 0,
      managementMode: 'managed' as const,
      healthy: false,
      version: undefined,
      db: await statusDatabase(manager, currentConfig),
    };
  }
  return {
    ...snapshot,
    configRevision,
    managementMode: 'managed' as const,
    healthy,
    version,
    db: database,
  };
}

async function statusDatabase(
  manager: ProcessManager,
  config: ReturnType<ProcessManager['getConfig']>
) {
  try {
    return managedStorageMode(config) === 'sqlite' ? await manager.dbStats(config.dataPath) : null;
  } catch {
    // Status must remain reachable so an invalid desired storage driver can be corrected.
    return null;
  }
}

export async function routeControlRequest(
  request: Request,
  pathname: string,
  method: string,
  manager: ProcessManager,
  runtime: WorkflowRuntimePort,
  lifecycle?: AgentLifecyclePort,
  controlTarget: ServerControlTarget = MANAGED_CONTROL_TARGET
): Promise<RouteResponse | null> {
  if (pathname === '/control/status') {
    return coordinatedLease(lifecycle, async () => ({
      status: 200,
      body: await statusWithHealth(manager, controlTarget),
    }));
  }
  if (pathname === '/control/logs') {
    return { status: 200, body: { lines: manager.getLogs() } };
  }
  if (pathname === '/control/start' && method === 'POST') {
    assertManagedControl(controlTarget);
    return coordinated(lifecycle, async () => {
      await manager.start();
      return { status: 200, body: await statusWithHealth(manager, controlTarget) };
    });
  }
  if (pathname === '/control/stop' && method === 'POST') {
    assertManagedControl(controlTarget);
    return coordinated(lifecycle, async () => {
      await stopWithRuntimeCleanup(manager, runtime);
      return { status: 200, body: await statusWithHealth(manager, controlTarget) };
    });
  }
  if (pathname === '/control/restart' && method === 'POST') {
    assertManagedControl(controlTarget);
    return coordinated(lifecycle, async () => {
      const closeResult = await settle(() => runtime.close());
      if (!closeResult.ok) {
        await stopAfterCloseFailure(manager, workflowCloseError(closeResult.error));
      }
      await manager.restart();
      return { status: 200, body: await statusWithHealth(manager, controlTarget) };
    });
  }
  if (pathname === '/control/config' && method === 'GET') {
    return { status: 200, body: configSnapshot(manager) };
  }
  if (pathname === '/control/config' && method === 'PUT') {
    assertManagedControl(controlTarget);
    const update = configUpdate(
      await readLimitedJsonBody(request, {
        scope: 'Agent configuration',
        maxBytes: MAX_CONFIG_BODY_BYTES,
        limitLabel: '64 KiB',
      })
    );
    return coordinated(lifecycle, async () => {
      manager.setConfig(update.patch, update.expectedRevision);
      return { status: 200, body: configSnapshot(manager) };
    });
  }
  return null;
}

function configSnapshot(manager: ProcessManager) {
  return { ...manager.getConfig(), configRevision: manager.getConfigRevision?.() ?? 0 };
}

function configUpdate(value: unknown): {
  patch: ReturnType<typeof validateConfigPatch>;
  expectedRevision?: number;
} {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { patch: validateConfigPatch(value) };
  }
  const input = { ...(value as Record<string, unknown>) };
  const hasExpectedRevision = Object.hasOwn(input, 'expectedRevision');
  const hasConfigRevision = Object.hasOwn(input, 'configRevision');
  const expected = hasExpectedRevision
    ? input.expectedRevision
    : hasConfigRevision
      ? input.configRevision
      : undefined;
  if (
    hasExpectedRevision &&
    hasConfigRevision &&
    input.expectedRevision !== input.configRevision
  ) {
    throw new Error('expectedRevision and configRevision must match');
  }
  delete input.expectedRevision;
  delete input.configRevision;
  if (expected !== undefined && (!Number.isSafeInteger(expected) || (expected as number) < 0)) {
    throw new Error('expectedRevision must be a non-negative safe integer');
  }
  return {
    patch: validateConfigPatch(input),
    ...(expected === undefined ? {} : { expectedRevision: expected as number }),
  };
}

export function assertManagedControl(controlTarget: ServerControlTarget): void {
  if (controlTarget.mode === 'external') {
    throw new Error(
      'Server lifecycle is disabled in external mode (BUNQUEUE_MANAGED=0); manage this broker with its external supervisor'
    );
  }
}

async function stopWithRuntimeCleanup(
  manager: ProcessManager,
  runtime: WorkflowRuntimePort
): Promise<void> {
  const closeResult = await settle(() => runtime.close());
  try {
    await manager.stop();
  } catch (stopFailure) {
    if (!closeResult.ok) throw combinedShutdownError(closeResult.error, stopFailure);
    throw stopFailure;
  }
  if (!closeResult.ok) throw workflowCloseError(closeResult.error);
}

async function stopAfterCloseFailure(
  manager: ProcessManager,
  closeFailure: unknown
): Promise<never> {
  try {
    await manager.stop();
  } catch (stopFailure) {
    throw combinedShutdownError(closeFailure, stopFailure);
  }
  throw closeFailure;
}

function combinedShutdownError(closeFailure: unknown, stopFailure: unknown): Error {
  return new WorkflowRuntimeUnavailableError(
    `Workflow Engine shutdown failed (${message(closeFailure)}); ` +
      `managed server stop also failed: ${message(stopFailure)}`
  );
}

function workflowCloseError(error: unknown): WorkflowRuntimeUnavailableError {
  try {
    if (error instanceof WorkflowRuntimeUnavailableError) return error;
  } catch {
    // A hostile thrown Proxy must still become an unavailable-runtime error.
  }
  return new WorkflowRuntimeUnavailableError(`Workflow Engine shutdown failed: ${message(error)}`);
}

function message(error: unknown): string {
  return safeErrorMessage(error);
}

function coordinated<T>(
  lifecycle: AgentLifecyclePort | undefined,
  operation: () => Promise<T>
): Promise<T> {
  return lifecycle ? lifecycle.run(operation) : operation();
}

function coordinatedLease<T>(
  lifecycle: AgentLifecyclePort | undefined,
  operation: () => Promise<T>
): Promise<T> {
  return lifecycle ? lifecycle.lease(operation) : operation();
}

function sameProcessSnapshot(
  initial: ReturnType<ProcessManager['getStatus']>,
  current: ReturnType<ProcessManager['getStatus']>
): boolean {
  return (
    initial.status === current.status &&
    initial.generation === current.generation &&
    initial.pid === current.pid &&
    initial.configRevision === current.configRevision
  );
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
