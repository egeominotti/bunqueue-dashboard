import { IconButton } from '@/components/ui/Button';
import { IconTrash } from '@/components/ui/icons';
import type { WorkerFull } from '@/lib/bqTypes';
import { cn } from '@/lib/cn';
import { formatNumber, formatRelativeTime } from '@/lib/format';

export const STALE_EXPLAINER = 'No heartbeat recently — derived from lastSeen';
export type SortKey = 'failed' | 'lastSeen';
export interface Sort {
  key: SortKey;
  dir: 'asc' | 'desc';
}

export function WorkersTable({
  rows,
  sort,
  busyIds,
  onSort,
  onRemove,
}: {
  rows: WorkerFull[];
  sort: Sort | null;
  busyIds: Set<string>;
  onSort: (key: SortKey) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-surface">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-faint">
            <th className="px-5 py-3 font-medium">Worker</th>
            <th className="px-5 py-3 font-medium">Queues</th>
            <th className="px-5 py-3 font-medium">Status</th>
            <th className="px-5 py-3 text-right font-medium">Active</th>
            <th className="px-5 py-3 text-right font-medium">Processed</th>
            <th className="px-5 py-3 text-right font-medium">
              <SortButton
                label="Failed"
                active={sort?.key === 'failed' ? sort.dir : null}
                onClick={() => onSort('failed')}
              />
            </th>
            <th className="px-5 py-3 text-right font-medium">
              <SortButton
                label="Last Seen"
                active={sort?.key === 'lastSeen' ? sort.dir : null}
                onClick={() => onSort('lastSeen')}
              />
            </th>
            <th className="w-16 px-5 py-3 text-right font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((worker) => (
            <tr
              key={worker.id}
              className="border-b border-line last:border-0 hover:bg-surface-2/40"
            >
              <td className="px-5 py-3">
                <div className="font-medium text-fg">{worker.name || 'worker'}</div>
                <div className="font-mono text-[11px] text-faint">{worker.id}</div>
              </td>
              <td className="px-5 py-3 font-mono text-xs text-muted">
                {worker.queues.join(', ') || '—'}
              </td>
              <td className="px-5 py-3">
                <span
                  title={worker.status === 'active' ? undefined : STALE_EXPLAINER}
                  className={cn(
                    'rounded-full px-2 py-0.5 text-[11px] font-medium',
                    worker.status === 'active'
                      ? 'bg-emerald-500/10 text-success'
                      : 'bg-amber-500/10 text-warning'
                  )}
                >
                  {worker.status}
                </span>
              </td>
              <td className="px-5 py-3 text-right tnum text-blue-400">
                {formatNumber(worker.activeJobs)}
              </td>
              <td className="px-5 py-3 text-right tnum text-muted">
                {formatNumber(worker.processedJobs)}
              </td>
              <td className="px-5 py-3 text-right tnum text-muted">
                {formatNumber(worker.failedJobs)}
              </td>
              <td className="px-5 py-3 text-right text-faint">
                {formatRelativeTime(worker.lastSeen)}
              </td>
              <td className="px-5 py-3">
                <div className="flex justify-end">
                  {worker.status === 'stale' && worker.activeJobs === 0 ? (
                    <IconButton
                      aria-label={`Remove stale registry record for worker ${worker.id}`}
                      title="Registry cleanup only — does not stop the worker process"
                      disabled={busyIds.has(worker.id)}
                      onClick={() => onRemove(worker.id)}
                    >
                      <IconTrash className="size-3.5" />
                    </IconButton>
                  ) : (
                    <span
                      className="text-xs text-faint"
                      title={
                        worker.status === 'stale'
                          ? 'Registry cleanup is blocked while active jobs are reported'
                          : 'Only stale, idle registry records can be removed'
                      }
                    >
                      —
                    </span>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SortButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: 'asc' | 'desc' | null;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={`Sort by ${label}`}
      className={cn(
        'inline-flex items-center gap-1 uppercase tracking-wider transition-colors hover:text-fg',
        active ? 'text-fg' : 'text-faint'
      )}
    >
      {label}
      <span aria-hidden="true">{active === 'desc' ? '↓' : active === 'asc' ? '↑' : ''}</span>
    </button>
  );
}
