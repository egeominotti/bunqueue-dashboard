import type { DbStats, ServerRunStatus } from '@/lib/bqTypes';

export interface BackupStatus {
  enabled: boolean;
  bucket: string;
  endpoint: string;
  interval: string;
  retention: string;
}

export interface BackupItem {
  key: string;
  size: string;
  date: string;
}

export interface BackupOperationResult {
  success: boolean;
  message: string;
  data?: unknown;
}

export interface BackupRestoreContext {
  serverStatus: ServerRunStatus;
  database: DbStats | null;
}

export interface BackupRepository {
  /** Capture immutable server/agent targets for a multi-request operation. */
  capture?(): BackupRepository;
  status(): Promise<BackupOperationResult & { data: BackupStatus }>;
  list(): Promise<BackupOperationResult & { data: BackupItem[] }>;
  backupNow(): Promise<BackupOperationResult>;
  restore(key: string, database: DbStats): Promise<BackupOperationResult>;
  configure(
    environment: Record<string, string>
  ): Promise<{ configured: boolean; enabled: boolean }>;
  restoreContext(): Promise<BackupRestoreContext>;
}
