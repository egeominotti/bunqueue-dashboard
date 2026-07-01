import { useState } from 'react';
import { EmptyState, LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { IconWorkers } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { StatCard } from '@/components/ui/StatCard';
import { api } from '@/lib/api';
import { formatNumber, formatRelativeTime } from '@/lib/format';
import type { OverviewResponse } from '@/lib/types';
import { usePolledData } from '@/lib/usePolledData';

const PAGE_SIZE = 20;

const EMPTY: Pick<OverviewResponse, 'workers'> = {
  workers: { total: 0, active: 0, list: [], truncated: false },
};

export function Workers() {
  const { data, error, loading, refetch } = usePolledData(() => api.overview(), []);
  const [page, setPage] = useState(0);

  if (loading && !data && !error) return <LoadingState label="Loading workers…" />;

  const { workers } = data ?? EMPTY;
  const pageCount = Math.max(1, Math.ceil(workers.list.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageWorkers = workers.list.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  return (
    <div>
      {error && <OfflineBanner onRetry={refetch} />}
      <PageHeader title="Workers" description="Registered workers and their throughput." live />

      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label="Total" value={formatNumber(workers.total)} compact />
        <StatCard label="Active" value={formatNumber(workers.active)} tone="green" compact />
      </div>

      {workers.list.length === 0 ? (
        <EmptyState
          icon={<IconWorkers />}
          title="No workers registered"
          hint="Workers appear here once they connect and register with the server."
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-faint">
                <th className="px-5 py-3 font-medium">Worker</th>
                <th className="px-5 py-3 font-medium">Queues</th>
                <th className="px-5 py-3 text-right font-medium">Active</th>
                <th className="px-5 py-3 text-right font-medium">Processed</th>
                <th className="px-5 py-3 text-right font-medium">Failed</th>
                <th className="px-5 py-3 text-right font-medium">Last Seen</th>
              </tr>
            </thead>
            <tbody>
              {pageWorkers.map((w) => (
                <tr key={w.id} className="border-b border-line last:border-0 hover:bg-surface-2/40">
                  <td className="px-5 py-3">
                    <div className="font-medium text-fg">{w.name || 'worker'}</div>
                    <div className="font-mono text-[11px] text-faint">{w.id}</div>
                  </td>
                  <td className="px-5 py-3 font-mono text-xs text-muted">
                    {w.queues.join(', ') || '—'}
                  </td>
                  <td className="px-5 py-3 text-right tnum text-blue-400">
                    {formatNumber(w.activeJobs)}
                  </td>
                  <td className="px-5 py-3 text-right tnum text-muted">
                    {formatNumber(w.processedJobs)}
                  </td>
                  <td className="px-5 py-3 text-right tnum text-muted">
                    {formatNumber(w.failedJobs)}
                  </td>
                  <td className="px-5 py-3 text-right text-faint">
                    {formatRelativeTime(w.lastSeen)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {workers.truncated && (
        <p className="mt-3 text-xs text-amber-400">
          Showing first {formatNumber(workers.list.length)} of {formatNumber(workers.total)}{' '}
          workers.
        </p>
      )}

      <Pagination
        page={safePage}
        pageSize={PAGE_SIZE}
        total={workers.list.length}
        onPageChange={setPage}
        label="workers"
      />
    </div>
  );
}
