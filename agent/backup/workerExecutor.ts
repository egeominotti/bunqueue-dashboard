import type { BackupOperation } from './runner';
import type { BackupWorkerReply, BackupWorkerRequest } from './workerProtocol';

export function executeBackupWorker(
  workerUrl: string,
  environment: Record<string, string>,
  operation: BackupOperation,
  key: string | undefined,
  signal: AbortSignal
): Promise<unknown> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, { type: 'module', env: environment });
    let settled = false;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      worker.terminate();
      operation();
    };
    const abort = () =>
      finish(() =>
        reject(
          signal.reason instanceof Error ? signal.reason : new Error('Backup operation cancelled')
        )
      );
    signal.addEventListener('abort', abort, { once: true });
    worker.onmessage = ({ data }: MessageEvent<BackupWorkerReply>) => {
      if (data.ok) finish(() => resolve(data.result));
      else finish(() => reject(new Error(data.error)));
    };
    worker.onerror = (event) => {
      event.preventDefault();
      finish(() => reject(new Error(event.message || 'Embedded backup worker failed')));
    };
    const request: BackupWorkerRequest = { operation, key };
    worker.postMessage(request);
  });
}
