import { Link } from 'react-router-dom';
import { IconButton } from '@/components/ui/Button';
import { IconEye, IconPlay } from '@/components/ui/icons';
import { Pagination } from '@/components/ui/Pagination';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { bq } from '@/lib/bq';
import type { JobFull } from '@/lib/bqTypes';
import { cn } from '@/lib/cn';
import { formatDateTime, formatDuration } from '@/lib/format';
import { actionGates } from '@/lib/jobActions';
import { JOBS_PAGE_SIZE, priorityLabel } from './model';

export function JobsTable({
  queue,
  rows,
  search,
  discoveryError,
  selected,
  allSelected,
  bulkBusy,
  busyIds,
  page,
  hasNext,
  onToggleAll,
  onToggle,
  onRun,
  onPage,
}: {
  queue: string;
  rows: JobFull[];
  search: string;
  discoveryError: boolean;
  selected: Set<string>;
  allSelected: boolean;
  bulkBusy: boolean;
  busyIds: Set<string>;
  page: number;
  hasNext: boolean;
  onToggleAll: () => void;
  onToggle: (id: string) => void;
  onRun: (job: JobFull, label: string, operation: () => Promise<unknown>) => void;
  onPage: (page: number) => void;
}) {
  return (
    <>
      {queue && (
        <div className="mb-2 flex items-center gap-2 text-sm">
          <span className="text-faint">Jobs in queue</span>
          <span className="rounded-md bg-surface-2 px-2 py-0.5 font-mono text-xs text-fg">
            {queue}
          </span>
        </div>
      )}
      <div className="overflow-x-auto rounded-xl border border-line bg-surface">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-faint">
              <th className="w-10 px-5 py-3">
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={(element) => {
                    if (element) element.indeterminate = selected.size > 0 && !allSelected;
                  }}
                  aria-checked={selected.size > 0 && !allSelected ? 'mixed' : allSelected}
                  onChange={onToggleAll}
                  aria-label="Select all jobs on page"
                  className="accent-accent"
                />
              </th>
              <th className="px-5 py-3 font-medium">Job ID</th>
              <th className="px-5 py-3 font-medium">Name</th>
              <th className="px-5 py-3 font-medium">Status</th>
              <th className="px-5 py-3 font-medium">Priority</th>
              <th className="px-5 py-3 text-right font-medium">Created</th>
              <th className="px-5 py-3 text-right font-medium">Duration</th>
              <th className="w-28 px-5 py-3 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-5 py-12 text-center text-sm text-faint">
                  {search.trim()
                    ? 'No jobs on this page match your ID or name filter.'
                    : queue
                      ? 'No jobs found.'
                      : discoveryError
                        ? 'Queue discovery failed. Retry above.'
                        : 'Select a queue.'}
                </td>
              </tr>
            ) : (
              rows.map((job) => {
                const priority = priorityLabel(job.priority);
                const gates = actionGates(job.state);
                const rowBusy = bulkBusy || busyIds.has(job.id);
                return (
                  <tr
                    key={job.id}
                    className="border-b border-line last:border-0 hover:bg-surface-2/40"
                  >
                    <td className="px-5 py-3">
                      <input
                        type="checkbox"
                        checked={selected.has(job.id)}
                        onChange={() => onToggle(job.id)}
                        aria-label={`Select job ${job.id}`}
                        className="accent-accent"
                      />
                    </td>
                    <td className="px-5 py-3 font-mono text-xs text-accent/90">
                      <span className="block max-w-[16rem] truncate" title={job.id}>
                        {job.id}
                      </span>
                    </td>
                    <td className="px-5 py-3 font-mono text-xs text-muted">
                      {job.name ?? 'default'}
                    </td>
                    <td className="px-5 py-3">
                      <StatusBadge status={String(job.state ?? 'waiting')} />
                    </td>
                    <td className={cn('px-5 py-3 text-xs font-semibold', priority.className)}>
                      {priority.text}
                    </td>
                    <td className="px-5 py-3 text-right text-faint">
                      {formatDateTime(job.createdAt)}
                    </td>
                    <td className="px-5 py-3 text-right tnum text-muted">
                      {formatDuration(
                        job.startedAt && job.completedAt
                          ? job.completedAt - job.startedAt
                          : undefined
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex justify-end gap-1">
                        <Link
                          to={`/job?id=${encodeURIComponent(job.id)}`}
                          aria-label={`Inspect job ${job.id}`}
                          className="inline-flex size-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                        >
                          <IconEye className="size-3.5" />
                        </Link>
                        {gates.promote && (
                          <IconButton
                            aria-label="Promote job"
                            disabled={rowBusy}
                            onClick={() => onRun(job, 'Promote', () => bq.promoteJob(job.id))}
                          >
                            <IconPlay className="size-3.5" />
                          </IconButton>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      <Pagination
        page={page}
        pageSize={JOBS_PAGE_SIZE}
        hasNext={hasNext}
        onPageChange={onPage}
        label="jobs"
      />
    </>
  );
}
