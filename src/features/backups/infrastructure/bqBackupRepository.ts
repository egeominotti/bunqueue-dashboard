import { getBaseUrl } from '@/components/dashboard/stores/connectionStore';
import { agentRequest } from '@/lib/bq';
import { agentHeadersFor, call, captureAgentRequestTarget } from '@/lib/bq/transport';
import type { ServerStatus } from '@/lib/bqTypes';
import type { BackupOperationResult, BackupRepository } from '../application/BackupRepository';

interface Envelope<T> {
  ok: true;
  result: T;
}

const post = (value?: unknown): RequestInit => ({
  method: 'POST',
  headers: value === undefined ? undefined : { 'Content-Type': 'application/json' },
  body: value === undefined ? undefined : JSON.stringify(value),
});
type BackupAgentRequest = <T>(path: string, init?: RequestInit) => Promise<T>;

function createRepository(target: () => string, request: BackupAgentRequest): BackupRepository {
  const result = async <T>(route: string, init?: RequestInit): Promise<T> =>
    (await request<Envelope<T>>(`${route}?target=${encodeURIComponent(target())}`, init)).result;

  return {
    status: () => result('/backup/status'),
    list: () => result('/backup/list'),
    backupNow: () => result<BackupOperationResult>('/backup/now', post()),
    restore: (key, database) =>
      result<BackupOperationResult>('/backup/restore', post({ key, database })),
    configure: (environment) => result('/backup/configure', post({ environment })),
    restoreContext: async () => {
      const status = await request<ServerStatus>('/control/status');
      return { serverStatus: status.status, database: status.db ?? null };
    },
  };
}

function captureRepository(): BackupRepository {
  const serverTarget = getBaseUrl();
  const agentTarget = captureAgentRequestTarget();
  const headers = { ...agentHeadersFor(agentTarget) };
  const request = <T>(route: string, init?: RequestInit): Promise<T> =>
    call<T>(agentTarget.baseUrl, route, headers, init, true, 'agent');
  return createRepository(() => serverTarget, request);
}

export const bqBackupRepository: BackupRepository = {
  ...createRepository(getBaseUrl, agentRequest),
  capture: captureRepository,
};
