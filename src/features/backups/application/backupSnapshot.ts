import { parseBackupList, parseBackupStatus } from '../domain/backupData';
import type { BackupRepository, BackupRestoreContext, BackupStatus } from './BackupRepository';
import type { BackupRunnerCoordinator } from './backupRunnerCoordinator';

export interface BackupSnapshot {
  status?: BackupStatus;
  backups: Awaited<ReturnType<BackupRepository['list']>>['data'];
  context?: BackupRestoreContext;
  errors: string[];
}

export function captureBackupRepository(repository: BackupRepository): BackupRepository {
  return repository.capture?.() ?? repository;
}

export async function loadBackupSnapshot(
  repository: BackupRepository,
  coordinator: BackupRunnerCoordinator,
  signal: AbortSignal
): Promise<BackupSnapshot> {
  // The restore context uses independent control/database endpoints. Start it
  // beside the serial status/list pair without holding the runner afterwards.
  const runnerSnapshot = await coordinator.run(async () => {
    const context = settle(() => repository.restoreContext());
    const status = await settle(() =>
      repository.status().then((result) => parseBackupStatus(result.data))
    );
    const list = await settle(() =>
      repository.list().then((result) => parseBackupList(result.data))
    );
    return { context, list, status };
  }, signal);
  const { list, status } = runnerSnapshot;
  const context = await runnerSnapshot.context;
  const errors = Array.from(
    new Set(
      [status, list, context]
        .filter((item): item is PromiseRejectedResult => item.status === 'rejected')
        .map((item) => (item.reason instanceof Error ? item.reason.message : String(item.reason)))
    )
  );
  return {
    status: status.status === 'fulfilled' ? status.value : undefined,
    backups: list.status === 'fulfilled' ? list.value : [],
    context: context.status === 'fulfilled' ? context.value : undefined,
    errors,
  };
}

async function settle<T>(operation: () => Promise<T>): Promise<PromiseSettledResult<T>> {
  try {
    return { status: 'fulfilled', value: await operation() };
  } catch (reason) {
    return { status: 'rejected', reason };
  }
}
