import { useEffect, useRef, useState } from 'react';
import { useConnectionStore } from '@/components/dashboard/stores/connectionStore';
import { usePolledData } from '@/lib/usePolledData';
import type {
  BackupItem,
  BackupOperationResult,
  BackupRepository,
  BackupRestoreContext,
  BackupStatus,
} from '../application/BackupRepository';
import { createBackupRunnerCoordinator } from '../application/backupRunnerCoordinator';
import { captureBackupRepository, loadBackupSnapshot } from '../application/backupSnapshot';
import { parseGeneratedEnvironment } from '../domain/environmentRecord';
import { bqBackupRepository } from '../infrastructure/bqBackupRepository';

interface OperationScope {
  connectionIdentity: string;
  repository: BackupRepository;
}

export function BackupOperationsPanel({
  environmentText,
  pollIntervalMs = 15_000,
  repository = bqBackupRepository,
}: {
  environmentText?: string;
  pollIntervalMs?: number;
  repository?: BackupRepository;
}) {
  const connectionIdentity = useConnectionStore((state) =>
    JSON.stringify([state.baseUrl, state.token, state.agentToken])
  );
  const mounted = useRef(true);
  const scopeRef = useRef<OperationScope | null>(null);
  if (
    !scopeRef.current ||
    scopeRef.current.connectionIdentity !== connectionIdentity ||
    scopeRef.current.repository !== repository
  ) {
    scopeRef.current = { connectionIdentity, repository };
  }
  const [coordinator] = useState(createBackupRunnerCoordinator);
  const snapshot = usePolledData(
    (signal) => loadBackupSnapshot(captureBackupRepository(repository), coordinator, signal),
    [repository, coordinator],
    {
      intervalMs: pollIntervalMs,
    }
  );
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const locked = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    locked.current = false;
    setBusy('');
    setError('');
    setNotice('');
  }, [connectionIdentity, repository]);
  const run = async (
    label: string,
    operation: (owner: BackupRepository) => Promise<BackupOperationResult | unknown>
  ) => {
    if (locked.current) return;
    const ownerScope = scopeRef.current;
    locked.current = true;
    setBusy(label);
    setError('');
    setNotice('');
    try {
      const owner = captureBackupRepository(repository);
      const result = await coordinator.run(async () => {
        if (!scopeIsCurrent(ownerScope, scopeRef, mounted)) {
          throw new Error('Backup operation scope changed before admission.');
        }
        return operation(owner);
      });
      if (!scopeIsCurrent(ownerScope, scopeRef, mounted)) return;
      const message = (result as BackupOperationResult | undefined)?.message;
      setNotice(message ?? `${label} completed.`);
      await snapshot.refetch();
    } catch (caught) {
      if (scopeIsCurrent(ownerScope, scopeRef, mounted)) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      if (scopeIsCurrent(ownerScope, scopeRef, mounted)) {
        locked.current = false;
        setBusy('');
      }
    }
  };
  const apply = () => {
    if (!environmentText) return;
    if (
      !window.confirm('Apply this S3 configuration to the managed server? A restart is required.')
    )
      return;
    void run('Configuration', (owner) =>
      owner.configure(parseGeneratedEnvironment(environmentText))
    );
  };
  const backup = () => {
    if (!window.confirm('Create a transactionally consistent S3 backup now?')) return;
    void run('Backup', (owner) => owner.backupNow());
  };
  const restore = (key: string) => {
    const database = snapshot.data?.context?.database;
    if (!database || snapshot.data?.context?.serverStatus !== 'stopped') return;
    if (window.prompt(`Type RESTORE to replace ${database.path} with ${key}`) !== 'RESTORE') return;
    void run('Restore', (owner) => owner.restore(key, database));
  };
  const data = snapshot.data;
  return (
    <section className="mt-6 overflow-hidden rounded-lg border border-line bg-surface">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-fg">Live backup operations</h2>
          <p className="mt-1 text-xs text-faint">
            Official Bunqueue 2.8.59 backup CLI, executed by the local control agent.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={!environmentText || Boolean(busy)}
            onClick={apply}
            className="rounded-md border border-line px-3 py-2 text-xs text-muted disabled:opacity-40"
          >
            Apply configuration
          </button>
          <button
            type="button"
            disabled={Boolean(busy)}
            onClick={backup}
            className="rounded-md bg-accent px-3 py-2 text-xs font-medium text-accent-fg disabled:opacity-40"
          >
            {busy === 'Backup' ? 'Backing up…' : 'Backup now'}
          </button>
          <button
            type="button"
            disabled={Boolean(busy) || snapshot.loading}
            onClick={() => void snapshot.refetch()}
            className="rounded-md border border-line px-3 py-2 text-xs text-muted disabled:opacity-40"
          >
            Refresh
          </button>
        </div>
      </header>
      {data?.status && <BackupStatusStrip status={data.status} context={data.context} />}
      {error || data?.errors.length ? (
        <div role="alert" className="border-b border-line px-4 py-3 text-xs text-danger">
          {error || data?.errors.join(' · ')}
        </div>
      ) : null}
      {notice && (
        <div role="status" className="border-b border-line px-4 py-3 text-xs text-success">
          {notice}
        </div>
      )}
      <BackupList
        rows={data?.backups ?? []}
        canRestore={data?.context?.serverStatus === 'stopped' && Boolean(data.context.database)}
        busy={Boolean(busy)}
        onRestore={restore}
      />
    </section>
  );
}

function BackupStatusStrip({
  status,
  context,
}: {
  status: BackupStatus;
  context?: BackupRestoreContext;
}) {
  const values = [
    ['Scheduler', status.enabled ? 'Enabled after restart' : 'Disabled'],
    ['Bucket', status.bucket || '—'],
    ['Endpoint', status.endpoint],
    ['Retention', status.retention],
    ['Server', context?.serverStatus ?? 'Unknown'],
  ];
  return (
    <dl className="grid border-b border-line sm:grid-cols-2 xl:grid-cols-5">
      {values.map(([label, value]) => (
        <div
          key={label}
          className="border-b border-line px-4 py-3 last:border-b-0 xl:border-r xl:border-b-0"
        >
          <dt className="text-[10px] uppercase tracking-wider text-faint">{label}</dt>
          <dd className="mt-1 truncate text-xs text-fg" title={value}>
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function BackupList({
  rows,
  canRestore,
  busy,
  onRestore,
}: {
  rows: BackupItem[];
  canRestore: boolean;
  busy: boolean;
  onRestore: (key: string) => void;
}) {
  if (!rows.length)
    return <p className="px-4 py-8 text-center text-sm text-muted">No backup objects returned.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[680px] text-left text-xs">
        <thead className="border-b border-line text-[10px] uppercase tracking-wider text-faint">
          <tr>
            <th className="px-4 py-2 font-medium">Object key</th>
            <th className="px-4 py-2 font-medium">Size</th>
            <th className="px-4 py-2 font-medium">Created</th>
            <th className="px-4 py-2 text-right font-medium">Restore</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((row) => (
            <tr key={row.key}>
              <td className="max-w-md truncate px-4 py-3 font-mono text-fg" title={row.key}>
                {row.key}
              </td>
              <td className="px-4 py-3 text-muted">{row.size}</td>
              <td className="px-4 py-3 text-muted">{row.date}</td>
              <td className="px-4 py-3 text-right">
                <button
                  type="button"
                  disabled={!canRestore || busy}
                  title={
                    canRestore ? 'Restore this backup' : 'Stop the managed server before restore'
                  }
                  onClick={() => onRestore(row.key)}
                  className="rounded-md border border-danger/40 px-2.5 py-1.5 text-danger disabled:opacity-35"
                >
                  Restore
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function scopeIsCurrent(
  owner: OperationScope | null,
  scope: { current: OperationScope | null },
  mounted: { current: boolean }
): boolean {
  return mounted.current && owner !== null && scope.current === owner;
}
