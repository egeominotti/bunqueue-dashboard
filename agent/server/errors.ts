import {
  DbExportBusyError,
  DbExportUnavailableError,
  MissingDbError,
} from '../db';
import { safeErrorMessage } from '../errorMessage';
import { QueueOperationsUnavailableError } from '../queue/types';
import { WorkflowRuntimeUnavailableError } from '../workflow/runtime';
import { AgentLifecycleClosedError } from './lifecycle';

const CONFLICT_MESSAGES = [
  'Start the managed Bunqueue server',
  'Stop the managed Bunqueue server',
  'Another backup operation is already running',
  'Another maintenance operation is already running',
  'Cannot start the managed Bunqueue server',
  'Cannot restart the managed Bunqueue server',
  'BUNQUEUE_WORKFLOW_QUEUE_NAME must',
  'BUNQUEUE_WORKFLOW_CONCURRENCY must',
  'Managed Bunqueue server restarted',
];

export function errorStatus(error: unknown): number {
  try {
    if (error instanceof AgentLifecycleClosedError) return 503;
    if (error instanceof MissingDbError) return 404;
    if (error instanceof DbExportBusyError) return 429;
    if (error instanceof DbExportUnavailableError) return 503;
    if (error instanceof QueueOperationsUnavailableError) {
      return error.message.includes('runtime is closed') ? 503 : 409;
    }
    if (error instanceof WorkflowRuntimeUnavailableError) {
      // Configuration shape is actionable by the caller; a missing/unreadable
      // configured module is an unavailable server-side dependency.
      return /^(Set BUNQUEUE_WORKFLOW_MODULE|BUNQUEUE_WORKFLOW_MODULE must|BUNQUEUE_WORKFLOW_QUEUE_NAME must|BUNQUEUE_WORKFLOW_CONCURRENCY must|Workflow module must|workflowNames must)/.test(error.message)
        ? 409
        : 503;
    }
  } catch {
    return 500;
  }
  const message = safeErrorMessage(error);
  return CONFLICT_MESSAGES.some((prefix) => message.startsWith(prefix)) ? 409 : 400;
}

export function errorMessage(error: unknown): string {
  return safeErrorMessage(error);
}
