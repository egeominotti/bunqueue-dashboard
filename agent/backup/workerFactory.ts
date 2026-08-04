import type { BackupOperationExecutor } from './runner';
import { executeBackupProcess } from './processExecutor';
import { executeBackupWorker } from './workerExecutor';

let embeddedWorkerUrl: string | null = null;

export const executeBackupOperation: BackupOperationExecutor = (
  environment,
  operation,
  key,
  signal
) => {
  if (embeddedWorkerUrl) {
    return executeBackupWorker(embeddedWorkerUrl, environment, operation, key, signal);
  }
  return executeBackupProcess(environment, operation, key, signal);
};

export function setBackupWorkerUrl(url: string | null): void {
  embeddedWorkerUrl = url;
}
