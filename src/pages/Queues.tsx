import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { IconArrowRight, IconQueues, IconSearch } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { StatCard } from '@/components/ui/StatCard';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatNumber } from '@/lib/format';
import type { QueuesResponse } from '@/lib/types';
import { usePolledData } from '@/lib/usePolledData';

const PAGE_SIZE = 20;
const EMPTY: QueuesResponse = {
  ok: false,
  queues: [],
  total: 0,
  limit: PAGE_SIZE,
  offset: 0,
  timestamp: 0,
};

export function Queues() {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const { data, error, loading, refetch } = usePolledData(
    () => api.queues(PAGE_SIZE, page * PAGE_SIZE),
    [page]
  );
  const { data: overview } = usePolledData(() => api.overview(), []);

  const d = data ?? EMPTY;

  const queues = useMemo(() => {
    const all = d.queues;
    const term = search.trim().toLowerCase();
    return term ? all.filter((q) => q.name.toLowerCase().includes(term)) : all;
  }, [d, search]);

  if (loading && !data && !error) return <LoadingState label="Loading queues…" />;

  const totals = overview?.stats;

  return (
    <div>
      {error && <OfflineBanner onRetry={refetch} />}
      <PageHeader title="Queues" description={`${d.total} queues`} live />

      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard
          label="Waiting"
          value={totals ? formatNumber(totals.waiting) : '—'}
          tone="amber"
          compact
        />
        <StatCard
          label="Active"
          value={totals ? formatNumber(totals.active) : '—'}
          tone="blue"
          compact
        />
        <StatCard
          label="Delayed"
          value={totals ? formatNumber(totals.delayed) : '—'}
          tone="default"
          compact
        />
        <StatCard
          label="DLQ"
          value={totals ? formatNumber(totals.dlq) : '—'}
          tone={totals?.dlq ? 'red' : 'default'}
          compact
        />
      </div>

      <div className="relative mb-4 max-w-sm">
        <IconSearch className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search queues…"
          className="h-9 w-full rounded-lg border border-line bg-surface pl-9 pr-3 text-sm text-fg placeholder:text-faint focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/30"
        />
      </div>

      <div className="overflow-hidden rounded-xl border border-line bg-surface">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-faint">
              <th className="px-5 py-3 font-medium">Queue</th>
              <th className="px-5 py-3 text-right font-medium">Waiting</th>
              <th className="px-5 py-3 text-right font-medium">Active</th>
              <th className="px-5 py-3 text-right font-medium">Delayed</th>
              <th className="px-5 py-3 text-right font-medium">DLQ</th>
              <th className="px-5 py-3 font-medium">Status</th>
              <th className="w-10 px-5 py-3" />
            </tr>
          </thead>
          <tbody>
            {queues.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-5 py-12 text-center text-sm text-faint">
                  {search ? 'No queues match on this page.' : 'No queues yet.'}
                </td>
              </tr>
            ) : (
              queues.map((qd) => (
                <tr
                  key={qd.name}
                  onClick={() => navigate(`/queues/${encodeURIComponent(qd.name)}`)}
                  className="group cursor-pointer border-b border-line last:border-0 transition-colors hover:bg-surface-2/50"
                >
                  <td className="px-5 py-3">
                    <span className="flex items-center gap-2 font-medium text-fg">
                      <IconQueues className="size-4 text-faint" />
                      {qd.name}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-right tnum text-muted">
                    {formatNumber(qd.waiting)}
                  </td>
                  <td className="px-5 py-3 text-right tnum text-blue-400">
                    {formatNumber(qd.active)}
                  </td>
                  <td className="px-5 py-3 text-right tnum text-muted">
                    {formatNumber(qd.delayed)}
                  </td>
                  <td
                    className={cn(
                      'px-5 py-3 text-right tnum',
                      qd.dlq ? 'text-red-400' : 'text-muted'
                    )}
                  >
                    {formatNumber(qd.dlq)}
                  </td>
                  <td className="px-5 py-3">
                    <span
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium',
                        qd.paused
                          ? 'bg-orange-500/10 text-orange-400'
                          : 'bg-emerald-500/10 text-emerald-400'
                      )}
                    >
                      <span className="size-1.5 rounded-full bg-current" />
                      {qd.paused ? 'Paused' : 'Active'}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-faint">
                    <IconArrowRight className="size-4 opacity-0 transition-opacity group-hover:opacity-100" />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Pagination
        page={page}
        pageSize={PAGE_SIZE}
        total={d.total}
        onPageChange={setPage}
        label="queues"
      />
    </div>
  );
}
