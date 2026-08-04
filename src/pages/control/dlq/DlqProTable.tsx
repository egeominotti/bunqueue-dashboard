import { Link } from 'react-router-dom';
import { IconButton } from '@/components/ui/Button';
import { IconRefresh } from '@/components/ui/icons';
import type { DlqEntryFull } from '@/lib/bqTypes';
import { cn } from '@/lib/cn';
import { FLOW_BULK_RETRY_UNAVAILABLE } from '@/lib/flowMutationSafety';
import { formatRelativeTime } from '@/lib/format';

export function DlqProTable({
  entries,
  expanded,
  onToggle,
}: {
  entries: DlqEntryFull[];
  expanded: Set<string>;
  onToggle: (key: string) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-surface">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-faint">
            <th className="px-5 py-3 font-medium">Job ID</th>
            <th className="px-5 py-3 font-medium">Name</th>
            <th className="px-5 py-3 font-medium">Reason</th>
            <th className="px-5 py-3 font-medium">Error</th>
            <th className="px-5 py-3 text-right font-medium">Entered</th>
            <th className="w-16 px-5 py-3" />
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => {
            const key = `${entry.job.id}-${entry.enteredAt}`;
            return (
              <tr
                key={key}
                className="border-b border-line last:border-0 align-top hover:bg-surface-2/40"
              >
                <td className="px-5 py-3">
                  <Link
                    to={`/job?id=${encodeURIComponent(entry.job.id)}`}
                    className="font-mono text-xs text-accent hover:underline"
                  >
                    {entry.job.id}
                  </Link>
                </td>
                <td className="px-5 py-3 font-mono text-xs text-muted">
                  {entry.job.name ?? 'default'}
                </td>
                <td className="px-5 py-3">
                  <span className="rounded-md bg-red-500/10 px-2 py-0.5 text-xs text-danger">
                    {entry.reason}
                  </span>
                </td>
                <td className="max-w-md px-5 py-3 text-xs text-danger/80">
                  {entry.error ? (
                    <button
                      type="button"
                      title={entry.error}
                      aria-expanded={expanded.has(key)}
                      onClick={() => onToggle(key)}
                      className={cn(
                        'block w-full break-words text-left',
                        !expanded.has(key) && 'line-clamp-2'
                      )}
                    >
                      {entry.error}
                    </button>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="px-5 py-3 text-right text-faint">
                  {formatRelativeTime(entry.enteredAt)}
                </td>
                <td className="px-5 py-3 text-right">
                  <IconButton
                    aria-label="Retry unavailable"
                    disabled
                    title={FLOW_BULK_RETRY_UNAVAILABLE}
                  >
                    <IconRefresh className="size-3.5" />
                  </IconButton>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
