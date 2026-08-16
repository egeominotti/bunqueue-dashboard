import type { ProcessManager, ServerConfig, StatusSnapshot } from '../manager';
import type { AgentLifecyclePort } from './lifecycle';

export interface ManagedRuntimeSnapshot {
  config: ServerConfig;
  running: boolean;
}

export type ManagedRuntimeAdmission = <T>(
  operation: (snapshot: ManagedRuntimeSnapshot) => Promise<T>
) => Promise<T>;

export type ManagedDatabaseAdmission = <T>(
  operation: (dataPath: string) => T | Promise<T>
) => Promise<T>;

/**
 * Admit SDK work against one managed-process generation. The operation and its
 * final state/config check share the same lifecycle section as start/stop.
 */
export function managedRuntimeAdmission(
  manager: ProcessManager,
  lifecycle: AgentLifecyclePort,
  initial: StatusSnapshot
): ManagedRuntimeAdmission {
  return (operation) =>
    lifecycle.lease(async () => {
      const current = manager.getStatus();
      if (generationChanged(initial, current)) {
        throw new Error('Managed Bunqueue server restarted while the request was prepared');
      }
      return operation({
        config: current.runningConfig ?? current.config,
        running: current.status === 'running',
      });
    });
}

/** Pin DB-backed observability to the live process config for one reader lease. */
export function managedDatabaseAdmission(
  manager: ProcessManager,
  lifecycle: AgentLifecyclePort
): ManagedDatabaseAdmission {
  return (operation) =>
    lifecycle.lease(async () => {
      const snapshot = manager.getStatus();
      return operation((snapshot.runningConfig ?? snapshot.config).dataPath);
    });
}

function generationChanged(initial: StatusSnapshot, current: StatusSnapshot): boolean {
  return (
    initial.status === 'running' &&
    current.status === 'running' &&
    initial.generation !== current.generation
  );
}
