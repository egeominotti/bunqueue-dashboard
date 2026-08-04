import { Button, IconButton } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Select } from '@/components/ui/form';
import { IconDownload, IconRefresh } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { FLOW_BULK_RETRY_UNAVAILABLE, FLOW_DELETION_UNAVAILABLE } from '@/lib/flowMutationSafety';
import { formatNumber } from '@/lib/format';

export interface DlqQueueOption {
  name: string;
  dlq: number;
}

export function DlqSummary({
  total,
  discoveryError,
  healthy,
  statsError,
  queue,
  topReason,
  pendingRetry,
  reasonCount,
}: {
  total: number | null;
  discoveryError: boolean;
  healthy: boolean;
  statsError: boolean;
  queue: string;
  topReason?: string;
  pendingRetry?: number;
  reasonCount?: number;
}) {
  return (
    <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
      <Card>
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium uppercase tracking-wider text-faint">
            Total in DLQ
          </span>
          <span
            className={cn(
              'rounded-full px-2 py-0.5 text-[11px] font-medium',
              discoveryError
                ? 'bg-amber-500/10 text-warning'
                : total == null
                  ? 'bg-surface-2 text-muted'
                  : healthy
                    ? 'bg-emerald-500/10 text-success'
                    : 'bg-red-500/10 text-danger'
            )}
          >
            {discoveryError
              ? 'Unavailable'
              : total == null
                ? 'Loading'
                : healthy
                  ? 'Healthy'
                  : 'Attention'}
          </span>
        </div>
        <div
          className={cn(
            'mt-2 text-3xl font-bold tnum',
            total == null || discoveryError
              ? 'text-muted'
              : healthy
                ? 'text-success'
                : 'text-danger'
          )}
        >
          {total == null ? '—' : formatNumber(total)}
        </div>
      </Card>
      <Card>
        <div className="text-[11px] font-medium uppercase tracking-wider text-faint">
          Top Reason
        </div>
        <div className="mt-2 text-lg font-semibold text-fg">
          {discoveryError || statsError
            ? 'Unavailable'
            : queue
              ? (topReason ?? 'No failures')
              : 'Select a queue'}
        </div>
      </Card>
      <Card>
        <div className="text-[11px] font-medium uppercase tracking-wider text-faint">
          Pending Retry
        </div>
        <div className="mt-2 text-3xl font-bold tnum text-fg">
          {pendingRetry == null ? '—' : formatNumber(pendingRetry)}
        </div>
        <div className="mt-1 text-xs text-faint">{queue ? 'in this queue' : 'awaiting retry'}</div>
      </Card>
      <Card>
        <div className="text-[11px] font-medium uppercase tracking-wider text-faint">
          Failure Types
        </div>
        <div className="mt-2 text-3xl font-bold tnum text-fg">
          {reasonCount == null ? '—' : formatNumber(reasonCount)}
        </div>
        <div className="mt-1 text-xs text-faint">distinct reasons</div>
      </Card>
    </div>
  );
}

export function DlqQueueGrid({
  queues,
  queue,
  onSelect,
}: {
  queues: DlqQueueOption[];
  queue: string;
  onSelect: (name: string) => void;
}) {
  if (queues.length === 0) return null;
  return (
    <Card className="mb-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wider text-faint">
          DLQ by queue
        </span>
        <div className="flex items-center gap-2">
          <Button size="sm" disabled title={FLOW_BULK_RETRY_UNAVAILABLE}>
            <IconRefresh className="size-3.5" /> Retry all ({queues.length} queues)
          </Button>
          <Button variant="danger" size="sm" disabled title={FLOW_DELETION_UNAVAILABLE}>
            Purge all ({queues.length} queues)
          </Button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-5">
        {queues.map((item) => (
          <button
            key={item.name}
            type="button"
            onClick={() => onSelect(item.name)}
            className={cn(
              'rounded-lg border p-3 text-left transition-colors',
              queue === item.name
                ? 'border-accent/50 bg-surface-2'
                : 'border-line hover:border-line-strong'
            )}
          >
            <div className="truncate font-mono text-xs text-muted">{item.name}</div>
            <div className="mt-1 text-xl font-bold tnum text-danger">{item.dlq}</div>
          </button>
        ))}
      </div>
    </Card>
  );
}

export function DlqFilters({
  queue,
  queues,
  reason,
  reasons,
  sort,
  search,
  pageScoped,
  onQueue,
  onReason,
  onSort,
  onSearch,
  onExport,
}: {
  queue: string;
  queues: DlqQueueOption[];
  reason: string;
  reasons: string[];
  sort: 'newest' | 'oldest';
  search: string;
  pageScoped: boolean;
  onQueue: (value: string) => void;
  onReason: (value: string) => void;
  onSort: (value: 'newest' | 'oldest') => void;
  onSearch: (value: string) => void;
  onExport: () => void;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3">
      <div className="w-48">
        <Select
          value={queue}
          aria-label="Queue"
          name="dlq-queue"
          autoComplete="off"
          onChange={(event) => onQueue(event.target.value)}
        >
          <option value="">Select a queue…</option>
          {queues.map((item) => (
            <option key={item.name} value={item.name}>
              {item.name}
              {item.dlq ? ` (${item.dlq})` : ''}
            </option>
          ))}
        </Select>
      </div>
      <div className="w-40">
        <Select
          value={reason}
          onChange={(event) => onReason(event.target.value)}
          aria-label="Filter by reason"
          name="dlq-reason-filter"
          autoComplete="off"
        >
          <option value="all">All Reasons</option>
          {reasons.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </Select>
      </div>
      <div className="w-36">
        <Select
          value={sort}
          onChange={(event) => onSort(event.target.value as 'newest' | 'oldest')}
          aria-label={pageScoped ? 'Sort this page' : 'Sort'}
          name="dlq-sort"
          autoComplete="off"
        >
          <option value="newest">Newest First{pageScoped ? ' (this page)' : ''}</option>
          <option value="oldest">Oldest First{pageScoped ? ' (this page)' : ''}</option>
        </Select>
      </div>
      <input
        value={search}
        onChange={(event) => onSearch(event.target.value)}
        placeholder="Filter this page by job ID…"
        aria-label="Filter this page by job ID"
        name="dlq-job-filter"
        autoComplete="off"
        className="h-9 min-w-40 flex-1 rounded-lg border border-line bg-surface px-3 text-sm text-fg placeholder:text-faint focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/30"
      />
      <Button size="sm" disabled title={FLOW_BULK_RETRY_UNAVAILABLE}>
        <IconRefresh className="size-3.5" /> Retry All
      </Button>
      <Button variant="danger" size="sm" disabled title={FLOW_DELETION_UNAVAILABLE}>
        Purge All
      </Button>
      <IconButton
        aria-label="Export this page to CSV"
        title="Export this page to CSV"
        disabled={!queue}
        onClick={onExport}
      >
        <IconDownload className="size-3.5" />
      </IconButton>
    </div>
  );
}
