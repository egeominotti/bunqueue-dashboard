import { getBaseUrl } from '@/components/dashboard/stores/connectionStore';
import { agentRequest } from '@/lib/bq';
import type { ServerStatus } from '@/lib/bqTypes';
import type { BackupOperationResult, BackupRepository } from '../application/BackupRepository';

interface Envelope<T> {
  ok: true;
  result: T;
}

const path = (value: string) => `${value}?target=${encodeURIComponent(getBaseUrl())}`;
const post = (value?: unknown): RequestInit => ({
  method: 'POST',
  headers: value === undefined ? undefined : { 'Content-Type': 'application/json' },
  body: value === undefined ? undefined : JSON.stringify(value),
});
const result = async <T>(route: string, init?: RequestInit): Promise<T> =>
  (await agentRequest<Envelope<T>>(path(route), init)).result;

export const bqBackupRepository: BackupRepository = {
  status: () => result('/backup/status'),
  list: () => result('/backup/list'),
  backupNow: () => result<BackupOperationResult>('/backup/now', post()),
  restore: (key, database) =>
    result<BackupOperationResult>('/backup/restore', post({ key, database })),
  configure: (environment) => result('/backup/configure', post({ environment })),
  restoreContext: async () => {
    const status = await agentRequest<ServerStatus>('/control/status');
    return { serverStatus: status.status, database: status.db ?? null };
  },
};
