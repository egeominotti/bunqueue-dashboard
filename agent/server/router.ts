import {
  executePreparedBackupRequest,
  prepareBackupRequest,
} from '../backup/routes';
import type { BackupRunnerPort } from '../backup/runner';
import { routeFlowRequest } from '../flow/routes';
import type { ManagedTargetPolicy } from '../managedTarget';
import type { ProcessManager } from '../manager';
import { routeQueueOperationsRequest } from '../queue/routes';
import type { QueueOperationsPort } from '../queue/types';
import type { WorkflowRuntimePort } from '../workflow/runtime';
import { routeWorkflowRuntimeRequest } from '../workflow/runtimeRoutes';
import { assertManagedControl, routeControlRequest } from './controlRoutes';
import type { ServerControlTarget } from './controlTarget';
import { routeDatabaseRequest } from './databaseRoutes';
import type { AgentLifecyclePort } from './lifecycle';
import { managedDatabaseAdmission, managedRuntimeAdmission } from './managedRuntime';
import type { RouteResponse } from './types';
import { routeWorkflowReadRequest } from './workflowReadRoutes';

export async function routeAgentRequest(
  request: Request,
  pathname: string,
  method: string,
  manager: ProcessManager,
  runtime: WorkflowRuntimePort,
  backupRunner: BackupRunnerPort,
  queueRuntime: QueueOperationsPort,
  lifecycle: AgentLifecyclePort,
  origin: string | null,
  allowedOrigins: string[],
  controlTarget: ServerControlTarget,
  managedTargetPolicy?: ManagedTargetPolicy
): Promise<RouteResponse | Response | null> {
  if (pathname.startsWith('/control/')) {
    const control = await routeControlRequest(
      request,
      pathname,
      method,
      manager,
      runtime,
      lifecycle,
      controlTarget
    );
    if (control) return control;
  }

  const snapshot = manager.getStatus();
  const managedConfig = snapshot.runningConfig ?? snapshot.config;
  const admission = managedRuntimeAdmission(manager, lifecycle, snapshot);
  const databaseAdmission = managedDatabaseAdmission(manager, lifecycle);
  if (pathname.startsWith('/flows/')) {
    const flow = await routeFlowRequest(
      request,
      pathname,
      method,
      managedConfig,
      snapshot.status === 'running',
      { admission, targetPolicy: managedTargetPolicy }
    );
    if (flow) return flow;
  }

  // Runtime control must precede the generic /workflows/:executionId reader,
  // otherwise GET /workflows/runtime is interpreted as an execution lookup.
  if (isWorkflowRuntimeRoute(pathname, method)) {
    const workflowRuntime = await routeWorkflowRuntimeRequest(
      request,
      pathname,
      method,
      managedConfig,
      runtime,
      snapshot.status === 'running',
      admission,
      managedTargetPolicy
    );
    if (workflowRuntime) return workflowRuntime;
  }

  if (isWorkflowReadRoute(pathname, method)) {
    const workflowRead = await routeWorkflowReadRequest(
      request,
      pathname,
      method,
      managedConfig.dataPath,
      databaseAdmission
    );
    if (workflowRead) return workflowRead;
  }

  if (pathname.startsWith('/queue-operations/')) {
    const queueOperation = await routeQueueOperationsRequest(
      request,
      pathname,
      method,
      managedConfig,
      queueRuntime,
      snapshot.status === 'running',
      admission,
      managedTargetPolicy
    );
    if (queueOperation) return queueOperation;
  }

  if (pathname.startsWith('/backup/')) {
    if (pathname === '/backup/restore' && method === 'POST') {
      assertManagedControl(controlTarget);
      const prepared = await prepareBackupRequest(
        request,
        pathname,
        method,
        managedConfig,
        managedTargetPolicy
      );
      if (!prepared || prepared.operation !== 'restore') return null;
      return lifecycle.run(() =>
        manager.withStoppedMaintenance('restoring a backup', async () => {
          const stoppedSnapshot = manager.getStatus();
          const restoreDesired = manager.getConfig();
          const restoreConfig = {
            ...(stoppedSnapshot.runningConfig ?? stoppedSnapshot.config),
            extraEnv: restoreDesired.extraEnv,
          };
          return executePreparedBackupRequest(
            prepared,
            restoreConfig,
            stoppedSnapshot.status === 'running',
            await manager.dbStats(restoreConfig.dataPath),
            backupRunner,
            undefined,
            managedTargetPolicy
          );
        })
      );
    }
    const prepared = await prepareBackupRequest(
      request,
      pathname,
      method,
      managedConfig,
      managedTargetPolicy
    );
    if (prepared) {
      const execute = async () => {
        const current = manager.getStatus();
        const desired = manager.getConfig();
        const effective = current.runningConfig ?? current.config;
        const backupConfig = { ...effective, extraEnv: desired.extraEnv };
        return executePreparedBackupRequest(
          prepared,
          backupConfig,
          current.status === 'running',
          await manager.dbStats(effective.dataPath),
          backupRunner,
          (extraEnv) => {
            manager.setConfig({ extraEnv });
          },
          managedTargetPolicy
        );
      };
      return prepared.operation === 'configure'
        ? lifecycle.run(execute)
        : lifecycle.lease(execute);
    }
  }

  return routeDatabaseRequest(
    request,
    pathname,
    method,
    managedConfig.dataPath,
    origin,
    allowedOrigins,
    databaseAdmission
  );
}

function isWorkflowRuntimeRoute(pathname: string, method: string): boolean {
  if (method === 'GET') return pathname === '/workflows/runtime';
  if (method !== 'POST') return false;
  return (
    [
      '/workflows/runtime/reload',
      '/workflows/start',
      '/workflows/recover',
      '/workflows/archive',
      '/workflows/cleanup',
    ].includes(pathname) ||
    /^\/workflows\/[^/]+\/(signal|resume-compensation|abandon-compensation)$/.test(pathname)
  );
}

function isWorkflowReadRoute(pathname: string, method: string): boolean {
  return method === 'GET' && (pathname === '/workflows' || pathname.startsWith('/workflows/'));
}
