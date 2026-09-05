import { basename } from 'node:path';
import { safeErrorMessage } from '../errorMessage';
import { managedConnection } from '../managedConnection';
import type { ServerConfig } from '../manager';
import type { WorkflowRuntimeStatus } from './runtime';

export class WorkflowRuntimeUnavailableError extends Error {}

export interface WorkflowRuntimeOptions {
  queueName: string;
  concurrency: number;
}

export interface RuntimeStatusSource extends WorkflowRuntimeOptions {
  moduleName: string;
  workflowNames: string[];
}

export function configuredWorkflowModule(config: ServerConfig): string | undefined {
  return effectiveEnvironment(config, 'BUNQUEUE_WORKFLOW_MODULE')?.trim() || undefined;
}

export function workflowRuntimeOptions(config: ServerConfig): WorkflowRuntimeOptions {
  const queueName = effectiveEnvironment(config, 'BUNQUEUE_WORKFLOW_QUEUE_NAME')?.trim() || '__wf:steps';
  if (queueName.length > 256 || /[\u0000-\u001f\u007f]/.test(queueName)) {
    throw new WorkflowRuntimeUnavailableError(
      'BUNQUEUE_WORKFLOW_QUEUE_NAME must contain 1–256 printable characters.'
    );
  }
  const rawConcurrency = effectiveEnvironment(config, 'BUNQUEUE_WORKFLOW_CONCURRENCY')?.trim();
  const concurrency = rawConcurrency ? Number(rawConcurrency) : 5;
  if (
    (rawConcurrency !== undefined && !/^\d+$/.test(rawConcurrency)) ||
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 1_000
  ) {
    throw new WorkflowRuntimeUnavailableError(
      'BUNQUEUE_WORKFLOW_CONCURRENCY must be an integer between 1 and 1000.'
    );
  }
  return { queueName, concurrency };
}

export function workflowRuntimeSignature(
  config: ServerConfig,
  path: string,
  modified: number,
  options: WorkflowRuntimeOptions
): string {
  return JSON.stringify([
    path,
    modified,
    config.dataPath,
    config.tcpPort,
    managedConnection(config),
    options.queueName,
    options.concurrency,
  ]);
}

export function stoppedRuntimeStatus(
  config: ServerConfig,
  modulePath: string
): WorkflowRuntimeStatus {
  try {
    return {
      configured: true,
      ready: false,
      moduleName: basename(modulePath),
      workflowNames: [],
      ...workflowRuntimeOptions(config),
      error: 'Managed Bunqueue server is stopped.',
    };
  } catch (error) {
    return {
      configured: true,
      ready: false,
      moduleName: basename(modulePath),
      workflowNames: [],
      error: messageOf(error),
    };
  }
}

export function readyRuntimeStatus(active: RuntimeStatusSource): WorkflowRuntimeStatus {
  return {
    configured: true,
    ready: true,
    moduleName: active.moduleName,
    workflowNames: active.workflowNames,
    queueName: active.queueName,
    concurrency: active.concurrency,
  };
}

export function messageOf(error: unknown): string {
  return safeErrorMessage(error);
}

function effectiveEnvironment(config: ServerConfig, key: string): string | undefined {
  return Object.hasOwn(config.extraEnv, key) ? config.extraEnv[key] : process.env[key];
}
