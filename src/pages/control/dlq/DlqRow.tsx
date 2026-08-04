import { Link } from 'react-router-dom';
import { IconButton } from '@/components/ui/Button';
import { CopyButton } from '@/components/ui/CopyButton';
import { IconChevronRight, IconEye, IconRefresh } from '@/components/ui/icons';
import type { DlqEntryFull } from '@/lib/bqTypes';
import { cn } from '@/lib/cn';
import { FLOW_BULK_RETRY_UNAVAILABLE } from '@/lib/flowMutationSafety';
import { formatDateTime, formatDuration, formatRelativeTime } from '@/lib/format';

export function DlqRow({
  entry,
  isOpen,
  onToggle,
  attempts,
}: {
  entry: DlqEntryFull;
  isOpen: boolean;
  onToggle: () => void;
  attempts: NonNullable<DlqEntryFull['attempts']>;
}) {
  return (
    <>
      <tr className="border-b border-line align-top last:border-0 hover:bg-surface-2/40">
        <td className="py-3 pl-4">
          <IconButton
            aria-label={isOpen ? 'Collapse details' : 'Expand details'}
            aria-expanded={isOpen}
            onClick={onToggle}
          >
            <IconChevronRight
              className={cn('size-3.5 transition-transform', isOpen && 'rotate-90')}
            />
          </IconButton>
        </td>
        <td className="px-3 py-3 font-mono text-xs text-muted">{entry.job.name ?? 'default'}</td>
        <td className="px-3 py-3">
          <div className="flex items-center gap-1">
            <Link
              to={`/job?id=${encodeURIComponent(entry.job.id)}`}
              className="max-w-[14rem] truncate font-mono text-xs text-accent hover:underline"
              title={entry.job.id}
            >
              {entry.job.id}
            </Link>
            <CopyButton value={entry.job.id} />
          </div>
        </td>
        <td className="px-3 py-3">
          <span className="inline-block rounded-md bg-red-500/10 px-2 py-0.5 text-xs text-danger">
            {entry.reason}
          </span>
        </td>
        <td className="px-3 py-3">
          <span
            className="block max-w-md truncate text-xs text-danger/80"
            title={entry.error ?? ''}
          >
            {entry.error || '—'}
          </span>
        </td>
        <td className="px-3 py-3 text-right tnum text-muted">
          {entry.job.attempts ?? attempts.length}
        </td>
        <td className="px-3 py-3 text-right text-faint" title={formatDateTime(entry.enteredAt)}>
          {formatRelativeTime(entry.enteredAt)}
        </td>
        <td className="px-4 py-3">
          <div className="flex items-center justify-end gap-1">
            <Link
              to={`/job?id=${encodeURIComponent(entry.job.id)}`}
              aria-label={`Inspect job ${entry.job.id}`}
              className="inline-flex size-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
            >
              <IconEye className="size-3.5" />
            </Link>
            <IconButton
              aria-label="Retry job unavailable"
              disabled
              title={FLOW_BULK_RETRY_UNAVAILABLE}
            >
              <IconRefresh className="size-3.5" />
            </IconButton>
          </div>
        </td>
      </tr>
      {isOpen && (
        <tr className="border-b border-line bg-surface-2/30 last:border-0">
          <td />
          <td colSpan={7} className="px-3 pb-4 pt-1">
            {entry.error && (
              <div className="mb-3">
                <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-faint">
                  Error
                </div>
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-surface p-3 font-mono text-xs text-danger/90">
                  {entry.error}
                </pre>
              </div>
            )}
            <div className="mb-1 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-faint">
              Failure history
              {typeof entry.retryCount === 'number' && entry.retryCount > 0 && (
                <span className="rounded-full bg-surface px-2 py-0.5 text-[10px] normal-case text-muted">
                  retried {entry.retryCount}×
                </span>
              )}
            </div>
            {attempts.length === 0 ? (
              <p className="text-xs text-faint">No per-attempt history recorded.</p>
            ) : (
              <ol className="space-y-1.5">
                {attempts.map((attempt) => (
                  <li
                    key={`${attempt.attempt}-${attempt.failedAt}`}
                    className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded-lg border border-line bg-surface px-3 py-2 text-xs"
                  >
                    <span className="font-medium text-fg">Attempt {attempt.attempt}</span>
                    <span className="text-faint" title={formatDateTime(attempt.failedAt)}>
                      {formatRelativeTime(attempt.failedAt)}
                    </span>
                    {attempt.duration != null && (
                      <span className="tnum text-muted">{formatDuration(attempt.duration)}</span>
                    )}
                    {attempt.reason && (
                      <span className="rounded bg-red-500/10 px-1.5 text-danger">
                        {attempt.reason}
                      </span>
                    )}
                    {attempt.error && (
                      <span className="w-full truncate text-danger/70">{attempt.error}</span>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
