import { executeBackupCommand } from '../../node_modules/bunqueue/dist/cli/commands/backup.js';
import type { BackupWorkerReply, BackupWorkerRequest } from './workerProtocol';

declare const self: Worker;

self.onmessage = async ({ data }: MessageEvent<BackupWorkerRequest>) => {
  let reply: BackupWorkerReply;
  try {
    const args = [
      data.operation,
      ...(data.operation === 'restore' ? [requiredKey(data.key), '--force'] : []),
    ];
    reply = { ok: true, result: await executeBackupCommand(args) };
  } catch (error) {
    reply = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  self.postMessage(reply);
};

function requiredKey(value: string | undefined): string {
  if (!value) throw new Error('Backup key is required for restore');
  return value;
}
