import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/form';
import { IconSearch } from '@/components/ui/icons';
import type { QueueSummaryFull } from '@/lib/bqTypes';
import { JOB_STATUSES, type JobStatusFilter, selectionLabel } from './model';

export function JobsToolbar({
  queue,
  summary,
  status,
  search,
  selectedTotal,
  selectedVisible,
  canPromote,
  bulkBusy,
  onQueue,
  onStatus,
  onSearch,
  onPromote,
}: {
  queue: string;
  summary: QueueSummaryFull[];
  status: JobStatusFilter;
  search: string;
  selectedTotal: number;
  selectedVisible: number;
  canPromote: boolean;
  bulkBusy: boolean;
  onQueue: (queue: string) => void;
  onStatus: (status: JobStatusFilter) => void;
  onSearch: (search: string) => void;
  onPromote: () => void;
}) {
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="w-48">
          <Select
            value={queue}
            aria-label="Queue"
            name="jobs-queue"
            autoComplete="off"
            onChange={(event) => onQueue(event.target.value)}
          >
            {summary.map((item) => (
              <option key={item.name} value={item.name}>
                {item.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-48">
          <Select
            aria-label="Job state"
            name="jobs-state"
            value={status}
            onChange={(event) => onStatus(event.target.value as JobStatusFilter)}
          >
            {JOB_STATUSES.map((item) => (
              <option key={item} value={item}>
                {item === 'all' ? 'All states' : item}
              </option>
            ))}
          </Select>
        </div>
        <div className="relative ml-auto min-w-56 flex-1 md:max-w-xs">
          <IconSearch className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
          <input
            value={search}
            onChange={(event) => onSearch(event.target.value)}
            placeholder="Filter this page by ID or name…"
            aria-label="Filter by job ID or name"
            name="jobs-id-filter"
            autoComplete="off"
            className="h-9 w-full rounded-lg border border-line bg-surface pl-9 pr-3 text-sm text-fg placeholder:text-faint focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
        </div>
      </div>
      {selectedTotal > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface-2 px-4 py-2 text-sm">
          <span className="mr-1 text-muted">{selectionLabel(selectedVisible, selectedTotal)}</span>
          {canPromote ? (
            <Button size="sm" disabled={bulkBusy} onClick={onPromote}>
              Promote selected
            </Button>
          ) : (
            <span className="text-xs text-faint">
              {selectedVisible === 0
                ? 'The selected jobs are hidden by the filter — clear it to act on them.'
                : 'No actions apply to the selected job states.'}
            </span>
          )}
        </div>
      )}
    </>
  );
}
