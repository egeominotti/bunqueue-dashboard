/** Full-control Bunqueue HTTP and local control-agent client. */

import { controlApi, dbApi, workflowApi } from './bq/agentApi';
import { getDbExportAtTarget, getDbRowsAtTarget } from './bq/database';
import { queueApi } from './bq/queueApi';
import { queueOperationsApi } from './bq/queueOperationsApi';
import { resourceApi } from './bq/resourceApi';
import { jobsApi, serverInfoApi } from './bq/serverApi';
import { createServerTargetClient } from './bq/targetClient';
import {
  captureAgentRequestTarget,
  captureServerRequestTarget,
  getAgentBase,
  getJobAtTarget,
} from './bq/transport';

export {
  DB_EXPORT_MAX_BYTES,
  DB_EXPORT_MAX_ROWS,
  getDbExportAtTarget,
  getDbRowsAtTarget,
} from './bq/database';
export {
  bulkJobPayloadBudgetError,
  MAX_BULK_JOB_COUNT,
  MAX_BULK_JOB_PAYLOAD_BYTES,
} from './bq/jobPayload';
export { createServerTargetClient, type ServerTargetClient } from './bq/targetClient';
export {
  type AgentRequestTarget,
  agentRequest,
  assertCurrentServerRequestTarget,
  BqError,
  captureAgentRequestTarget,
  captureServerRequestTarget,
  getJobAtTarget,
  resolveAgentBase,
  SAFE_AGENT_BASE,
  type ServerRequestTarget,
  setRequestTimeoutMs,
} from './bq/transport';
export type {
  AddJobBody,
  AddWebhookBody,
  Backoff,
  BulkJobBody,
  CreateCronBody,
  CronJobOptions,
  DbCsvExportResult,
  DbExportCap,
  DbExportRequest,
  DbFilter,
  DbRowId,
  DbRowsPage,
  DedupOptions,
  HeapMB,
  RepeatOptions,
} from './bq/types';
export { WEBHOOK_EVENTS } from './bq/types';

export const bq = {
  ...serverInfoApi,
  captureServerRequestTarget,
  createServerTargetClient,
  getJobAtTarget,
  captureAgentRequestTarget,
  getDbRowsAtTarget,
  getDbExportAtTarget,
  ...jobsApi,
  ...queueApi,
  queueOperations: queueOperationsApi,
  ...resourceApi,
  db: dbApi,
  get agentBase() {
    return getAgentBase();
  },
  control: controlApi,
  workflows: workflowApi,
};

Object.defineProperty(bq, 'agentBase', { configurable: false });
