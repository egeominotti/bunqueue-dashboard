export interface BackupRunnerCoordinator {
  run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

/** FIFO admission for Bunqueue's process-wide, single-operation backup runner. */
export function createBackupRunnerCoordinator(): BackupRunnerCoordinator {
  let tail = Promise.resolve();
  return {
    async run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      const predecessor = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await predecessor;
      try {
        signal?.throwIfAborted();
        return await operation();
      } finally {
        release();
      }
    },
  };
}
