import { Select } from '@/components/ui/form';
import { IconSearch } from '@/components/ui/icons';
import { StatCard } from '@/components/ui/StatCard';
import { formatNumber, formatRelativeTime } from '@/lib/format';

interface QueueOption {
  name: string;
  dlq: number;
}

export function DlqStatsCards({
  queue,
  data,
  reasons,
  topReason,
}: {
  queue: string;
  data: {
    total: number;
    stats: { pendingRetry?: number; oldestEntry?: number | null } | null;
  } | null;
  reasons: string[];
  topReason?: string;
}) {
  return (
    <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
      <StatCard
        label="Entries"
        value={queue && data ? formatNumber(data.total) : '—'}
        tone={!queue || !data ? 'default' : data.total ? 'red' : 'green'}
        hint={
          !queue || !data
            ? 'waiting for queue data'
            : data.total
              ? topReason
                ? `top: ${topReason}`
                : undefined
              : 'queue is clean'
        }
        compact
      />
      <StatCard
        label="Failure types"
        value={data?.stats ? formatNumber(reasons.length) : '—'}
        hint="distinct reasons"
        compact
      />
      <StatCard
        label="Pending retry"
        value={data?.stats ? formatNumber(data.stats.pendingRetry ?? 0) : '—'}
        tone={data?.stats?.pendingRetry ? 'amber' : 'default'}
        hint="auto-retry queued"
        compact
      />
      <StatCard
        label="Oldest entry"
        value={data?.stats?.oldestEntry ? formatRelativeTime(data.stats.oldestEntry) : '—'}
        hint="time in DLQ"
        compact
      />
    </div>
  );
}

export function DlqToolbar({
  queue,
  queues,
  reason,
  reasons,
  byReason,
  search,
  pageScoped,
  onQueue,
  onReason,
  onSearch,
}: {
  queue: string;
  queues: QueueOption[];
  reason: string;
  reasons: string[];
  byReason: Record<string, number>;
  search: string;
  pageScoped: boolean;
  onQueue: (queue: string) => void;
  onReason: (reason: string) => void;
  onSearch: (search: string) => void;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3">
      <div className="w-56">
        <Select
          value={queue}
          aria-label="Queue"
          name="dlq-control-queue"
          autoComplete="off"
          onChange={(event) => onQueue(event.target.value)}
        >
          {queues.map((item) => (
            <option key={item.name} value={item.name}>
              {item.name} {item.dlq ? `(${item.dlq})` : ''}
            </option>
          ))}
        </Select>
      </div>
      <div className="w-44">
        <Select
          value={reason}
          aria-label="Filter by reason"
          name="dlq-control-reason"
          autoComplete="off"
          onChange={(event) => onReason(event.target.value)}
        >
          <option value="all">All reasons</option>
          {reasons.map((item) => (
            <option key={item} value={item}>
              {item} ({byReason[item]})
            </option>
          ))}
        </Select>
      </div>
      <div className="relative min-w-40 flex-1">
        <IconSearch className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
        <input
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          placeholder={pageScoped ? 'Filter this page by job ID…' : 'Filter by job ID…'}
          aria-label="Filter by job ID"
          name="dlq-control-job-filter"
          autoComplete="off"
          className="h-9 w-full rounded-lg border border-line bg-surface pl-9 pr-3 text-sm text-fg placeholder:text-faint focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/30"
        />
      </div>
    </div>
  );
}
