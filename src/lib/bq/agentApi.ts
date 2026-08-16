import type {
  ServerConfig,
  ServerConfigSnapshot,
  ServerLogLine,
  ServerStatus,
  WorkflowExecutionDetail,
  WorkflowExecutionsPage,
  WorkflowStateFilter,
  WorkflowStats,
  WorkflowStoreKind,
} from '../bqTypes';
import { decodedHttpPathSegment } from '../upstreamPaths';
import { agentRequest, body } from './transport';
import type { DbFilter, DbRowId, DbRowsPage } from './types';

const q = encodeURIComponent;

export const dbApi = {
  info: () =>
    agentRequest<{
      ok: boolean;
      sqliteVersion: string;
      pageSize: number;
      pageCount: number;
      journalMode: string;
      freelistPages: number;
      tables: number;
      indexes: number;
      fileSize: number;
      walSize: number;
    }>('/db/info'),
  tables: () =>
    agentRequest<{ ok: boolean; tables: { name: string; rows: number; columns: number }[] }>(
      '/db/tables'
    ),
  schema: (table: string) =>
    agentRequest<{
      ok: boolean;
      table: string;
      columns: {
        name: string;
        type: string;
        notNull: boolean;
        defaultValue: string | null;
        primaryKey: boolean;
      }[];
      indexes: { name: string; unique: boolean; columns: string[] }[];
      sql: string | null;
      rowCount: number;
    }>(`/db/tables/${decodedHttpPathSegment(table, 'Database table')}/schema`),
  rows: (
    table: string,
    limit = 50,
    offset = 0,
    orderBy?: string,
    dir: 'asc' | 'desc' = 'asc',
    filter?: DbFilter
  ) =>
    agentRequest<DbRowsPage>(
      `/db/tables/${decodedHttpPathSegment(table, 'Database table')}?limit=${limit}&offset=${offset}${
        orderBy ? `&orderBy=${q(orderBy)}&dir=${dir}` : ''
      }${filter?.value ? `&fcol=${q(filter.column)}&fop=${filter.op}&fval=${q(filter.value)}` : ''}`
    ),
  cell: (table: string, rowid: DbRowId, column: string) =>
    agentRequest<{ ok: boolean; value: unknown }>(
      `/db/tables/${decodedHttpPathSegment(table, 'Database table')}/cell?rowid=${q(String(rowid))}&column=${q(column)}`
    ),
  query: (sql: string) =>
    agentRequest<{
      ok: boolean;
      columns: string[];
      rows: unknown[][];
      rowCount: number;
      truncated: boolean;
      ms: number;
    }>('/db/query', body('POST', { sql })),
};

export const controlApi = {
  status: () => agentRequest<ServerStatus>('/control/status'),
  start: () => agentRequest<ServerStatus>('/control/start', { method: 'POST' }),
  stop: () => agentRequest<ServerStatus>('/control/stop', { method: 'POST' }),
  restart: () => agentRequest<ServerStatus>('/control/restart', { method: 'POST' }),
  logs: () => agentRequest<{ lines: ServerLogLine[] }>('/control/logs'),
  getConfig: () => agentRequest<ServerConfigSnapshot>('/control/config'),
  setConfig: (config: Partial<ServerConfig>, expectedRevision?: number) =>
    agentRequest<ServerConfigSnapshot>(
      '/control/config',
      body('PUT', {
        ...config,
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      })
    ),
};

export const workflowApi = {
  stats: () => agentRequest<WorkflowStats>('/workflows/stats'),
  list: (
    options: {
      kind?: WorkflowStoreKind;
      workflowName?: string;
      state?: WorkflowStateFilter;
      limit?: number;
      offset?: number;
    } = {}
  ) => {
    const params = new URLSearchParams();
    if (options.kind) params.set('kind', options.kind);
    if (options.workflowName) params.set('workflowName', options.workflowName);
    if (options.state) params.set('state', options.state);
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    if (options.offset !== undefined) params.set('offset', String(options.offset));
    return agentRequest<WorkflowExecutionsPage>(`/workflows${params.size ? `?${params}` : ''}`);
  },
  get: (id: string, kind: WorkflowStoreKind = 'active') =>
    agentRequest<{ ok: boolean; execution: WorkflowExecutionDetail }>(
      `/workflows/${decodedHttpPathSegment(id, 'Workflow execution id')}?kind=${kind}`
    ),
};
