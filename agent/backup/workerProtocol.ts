import type { BackupCommandResult, BackupOperation } from './runner';

export interface BackupWorkerRequest {
  operation: BackupOperation;
  key?: string;
}

export type BackupWorkerReply =
  | { ok: true; result: BackupCommandResult }
  | { ok: false; error: string };
