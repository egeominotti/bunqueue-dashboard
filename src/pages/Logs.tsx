import { useEffect, useMemo, useState } from 'react';
import { EmptyState, OfflineBanner } from '@/components/ui/feedback';
import { SegmentedControl, Select } from '@/components/ui/form';
import { IconLogs, IconSearch } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { StatCard } from '@/components/ui/StatCard';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { api } from '@/lib/api';
import { formatNumber, formatRelativeTime } from '@/lib/format';
import { useActivityStream } from '@/lib/useActivityStream';
import { usePolledData } from '@/lib/usePolledData';

const ALL = '__all__';
const STATUS = ['all', 'waiting', 'active', 'completed', 'failed'] as const;
type StatusFilter = (typeof STATUS)[number];
const PAGE = 10;

export function Logs() {
  const [queue, setQueue] = useState(ALL);
  const [status, setStatus] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);

  const { data: qs } = usePolledData(() => api.queues(500), [], { intervalMs: 30000 });
  const { events, counters, throughput, connected } = useActivityStream(
    queue === ALL ? undefined : queue
  );

  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return events.filter((e) => {
      if (status !== 'all' && e.status !== status) return false;
      if (!term) return true;
      return (
        (e.jobId ?? '').toLowerCase().includes(term) ||
        (e.name ?? '').toLowerCase().includes(term) ||
        (e.queue ?? '').toLowerCase().includes(term)
      );
    });
  }, [events, status, search]);

  // Reset to first page when filters change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on filter change
  useEffect(() => setPage(0), [queue, status, search]);

  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE));
  const safePage = Math.min(page, pageCount - 1);

  return (
    <div>
      {!connected && events.length === 0 && <OfflineBanner />}
      <PageHeader
        title="Activity Logs"
        description="Real-time job activity across all queues."
        live={connected}
      />

      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Total Events" value={formatNumber(counters.total)} compact />
        <StatCard label="Completed" value={formatNumber(counters.completed)} tone="green" compact />
        <StatCard
          label="Failed"
          value={formatNumber(counters.failed)}
          tone={counters.failed ? 'red' : 'default'}
          compact
        />
        <StatCard label="Waiting" value={formatNumber(counters.waiting)} tone="amber" compact />
        <StatCard label="Active" value={formatNumber(counters.active)} tone="blue" compact />
        <StatCard label="Throughput" value={`${throughput.toFixed(1)}/s`} tone="accent" compact />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="w-48">
          <Select value={queue} onChange={(e) => setQueue(e.target.value)}>
            <option value={ALL}>All Queues</option>
            {(qs?.queues ?? []).map((q) => (
              <option key={q.name} value={q.name}>
                {q.name}
              </option>
            ))}
          </Select>
        </div>
        <SegmentedControl options={STATUS} value={status} onChange={setStatus} />
        <div className="relative ml-auto min-w-56 flex-1 md:max-w-xs">
          <IconSearch className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by job name or ID…"
            className="h-9 w-full rounded-lg border border-line bg-surface pl-9 pr-3 text-sm text-fg placeholder:text-faint focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={<IconLogs />}
          title={connected ? 'Waiting for activity…' : 'Connecting to the event stream…'}
          hint="Job events stream in here live as they happen on the server."
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-faint">
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 font-medium">Job Name</th>
                <th className="px-5 py-3 font-medium">Queue</th>
                <th className="px-5 py-3 text-right font-medium">Timestamp</th>
                <th className="px-5 py-3 text-right font-medium">ID</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(safePage * PAGE, safePage * PAGE + PAGE).map((e) => (
                <tr
                  key={e.seq}
                  className="border-b border-line last:border-0 hover:bg-surface-2/40"
                >
                  <td className="px-5 py-3">
                    <StatusBadge status={e.status} />
                  </td>
                  <td className="px-5 py-3 text-fg">{e.name || 'unknown'}</td>
                  <td className="px-5 py-3">
                    <span className="rounded-md bg-surface-2 px-2 py-0.5 font-mono text-xs text-muted">
                      {e.queue || '—'}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-right text-faint">
                    {formatRelativeTime(e.timestamp)}
                  </td>
                  <td className="px-5 py-3 text-right font-mono text-xs text-faint">
                    {e.jobId || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pagination
        page={safePage}
        pageSize={PAGE}
        total={rows.length}
        onPageChange={setPage}
        label="events"
      />
    </div>
  );
}
