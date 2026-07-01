import { Card } from '@/components/ui/Card';
import { CopyButton } from '@/components/ui/CopyButton';
import type { DbStats } from '@/lib/bqTypes';
import { cn } from '@/lib/cn';
import { formatBytes, formatRelativeTime } from '@/lib/format';

const SEGMENTS = [
  { key: 'size', label: 'Database', color: 'bg-accent' },
  { key: 'walSize', label: 'WAL', color: 'bg-amber-400' },
  { key: 'shmSize', label: 'SHM', color: 'bg-zinc-500' },
] as const;

/**
 * On-disk footprint of the SQLite store as one proportional bar (db + WAL +
 * SHM) instead of a row of identical stat cards — the shape of the data is the
 * information.
 */
export function StoragePanel({ db }: { db: DbStats }) {
  const total = db.totalSize || 0;

  return (
    <Card>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <h3 className="text-base font-semibold text-fg">Storage</h3>
        <span className="font-mono text-xs text-muted">
          {db.exists ? `${formatBytes(total)} on disk` : 'not created yet'}
        </span>
      </div>
      <p
        className="mb-4 flex items-center gap-1.5 truncate font-mono text-xs text-faint"
        title={db.path}
      >
        <span className="truncate">{db.path}</span>
        <CopyButton value={db.path} />
      </p>

      {db.exists && total > 0 ? (
        <>
          <div className="flex h-2.5 overflow-hidden rounded-full bg-surface-2">
            {SEGMENTS.map((s) => {
              const bytes = db[s.key];
              if (!bytes) return null;
              return (
                <div
                  key={s.key}
                  className={cn('h-full', s.color)}
                  style={{ width: `${(bytes / total) * 100}%` }}
                  title={`${s.label}: ${formatBytes(bytes)}`}
                />
              );
            })}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 font-mono text-[11px] text-faint">
            {SEGMENTS.map((s) => (
              <span key={s.key} className="flex items-center gap-1.5">
                <span className={cn('size-2 rounded-full', s.color)} />
                {s.label} <span className="text-fg">{formatBytes(db[s.key])}</span>
              </span>
            ))}
            {db.mtimeMs ? (
              <span className="ml-auto">written {formatRelativeTime(db.mtimeMs)}</span>
            ) : null}
          </div>
        </>
      ) : (
        <p className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-sm text-faint">
          The database appears here after the first start — SQLite creates the file at the
          configured data path.
        </p>
      )}
    </Card>
  );
}
