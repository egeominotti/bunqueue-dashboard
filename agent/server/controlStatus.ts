import {
  managedPostgresNamespace,
  managedPostgresTarget,
  managedStorageMode,
  type ProcessManager,
} from '../manager';
import { probeExternalHealth, type ServerControlTarget } from './controlTarget';

export async function statusWithHealth(
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
  const storageMode = statusStorageMode(effectiveConfig);
  const database = await statusDatabase(manager, effectiveConfig);
  const current = manager.getStatus();
  if (!sameProcessSnapshot(snapshot, current)) {
    if (retryOnProcessChange) return statusWithHealth(manager, controlTarget, false);
    const currentConfig = current.runningConfig ?? current.config;
    const currentStorageMode = statusStorageMode(currentConfig);
    return {
      ...current,
      configRevision: current.configRevision ?? manager.getConfigRevision?.() ?? 0,
      managementMode: 'managed' as const,
      healthy: false,
      version: undefined,
      storageMode: currentStorageMode,
      postgresNamespace:
        currentStorageMode === 'postgres' ? managedPostgresNamespace(currentConfig) : undefined,
      postgresTarget:
        currentStorageMode === 'postgres' ? managedPostgresTarget(currentConfig) : undefined,
      db: await statusDatabase(manager, currentConfig),
    };
  }
  return {
    ...snapshot,
    configRevision,
    managementMode: 'managed' as const,
    healthy,
    version,
    storageMode,
    postgresNamespace:
      storageMode === 'postgres' ? managedPostgresNamespace(effectiveConfig) : undefined,
    postgresTarget:
      storageMode === 'postgres' ? managedPostgresTarget(effectiveConfig) : undefined,
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

function statusStorageMode(
  config: ReturnType<ProcessManager['getConfig']>
): ReturnType<typeof managedStorageMode> | undefined {
  try {
    return managedStorageMode(config);
  } catch {
    return undefined;
  }
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
