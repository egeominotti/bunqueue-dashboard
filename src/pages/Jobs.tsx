import { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { IconButton } from '@/components/ui/Button';
import { LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { SegmentedControl, Select } from '@/components/ui/form';
import { IconSearch, IconTrash } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatCard } from '@/components/ui/StatCard';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { api } from '@/lib/api';
import {
  errorRate,
  formatDuration,
  formatNumber,
  formatPercent,
  formatRelativeTime,
  jobDuration,
} from '@/lib/format';
import type { Job } from '@/lib/types';
import { usePolledData } from '@/lib/usePolledData';

const ALL = '__all__';
const STATUS = ['all', 'waiting', 'active', 'completed', 'failed'] as const;
type StatusFilter = (typeof STATUS)[number];

export function Jobs() {
  const [params] = useSearchParams();
  const [queue, setQueue] = useState(params.get('queue') ?? ALL);
  const [status, setStatus] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');

  const { data: qs } = usePolledData(() => api.queues(500), []);
  const { data: overview } = usePolledData(() => api.overview(), []);

  const fetcher = useCallback(async () => {
    const names = queue === ALL ? (qs?.queues ?? []).map((q) => q.name).slice(0, 25) : [queue];
    const states = status === 'all' ? undefined : [status];
    const batches = await Promise.all(
      names.map((n) =>
        api
          .jobsList(n, { states, limit: 40 })
          .then((r) => (r.jobs ?? []).map((j) => ({ ...j, queue: j.queue ?? n })))
          .catch(() => [] as Job[])
      )
    );
    return batches.flat().sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  }, [queue, status, qs]);

  const { data: jobs, error, loading, refetch } = usePolledData(fetcher, [queue, status]);

  const rows = useMemo(() => {
    const list = jobs ?? [];
    const term = search.trim().toLowerCase();
    const filtered = term
      ? list.filter(
          (j) => j.id.toLowerCase().includes(term) || (j.name ?? '').toLowerCase().includes(term)
        )
      : list;
    return filtered.slice(0, 100);
  }, [jobs, search]);

  const stats = overview?.stats;
  const rate = stats ? (errorRate(stats.totalCompleted, stats.totalFailed) ?? 0) : 0;

  const cancel = async (id: string) => {
    if (!window.confirm(`Cancel job ${id}?`)) return;
    try {
      await api.cancelJob(id);
      refetch();
    } catch {
      /* ignore, next poll reflects state */
    }
  };

  return (
    <div>
      {error && <OfflineBanner onRetry={refetch} />}
      <PageHeader
        title="Jobs Explorer"
        description="Browse, inspect, and manage individual jobs."
        live
      />

      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        <StatCard
          label="Total"
          value={formatNumber(
            (stats?.totalCompleted ?? 0) +
              (stats?.totalFailed ?? 0) +
              (stats?.waiting ?? 0) +
              (stats?.active ?? 0)
          )}
          compact
        />
        <StatCard label="Waiting" value={formatNumber(stats?.waiting)} tone="amber" compact />
        <StatCard label="Active" value={formatNumber(stats?.active)} tone="blue" compact />
        <StatCard
          label="Completed"
          value={formatNumber(stats?.totalCompleted)}
          tone="green"
          compact
        />
        <StatCard
          label="Failed"
          value={formatNumber(stats?.totalFailed)}
          tone={stats?.totalFailed ? 'red' : 'default'}
          compact
        />
        <StatCard
          label="Error Rate"
          value={formatPercent(rate)}
          tone={rate > 0.05 ? 'red' : 'green'}
          compact
        />
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
            placeholder="Search by ID or name…"
            className="h-9 w-full rounded-lg border border-line bg-surface pl-9 pr-3 text-sm text-fg placeholder:text-faint focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
        </div>
      </div>

      {loading && !jobs && !error ? (
        <LoadingState label="Loading jobs…" />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-faint">
                <th className="px-5 py-3 font-medium">Job ID</th>
                <th className="px-5 py-3 font-medium">Name</th>
                <th className="px-5 py-3 font-medium">Queue</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 text-right font-medium">Priority</th>
                <th className="px-5 py-3 text-right font-medium">Created</th>
                <th className="px-5 py-3 text-right font-medium">Duration</th>
                <th className="w-12 px-5 py-3" />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-5 py-12 text-center text-sm text-faint">
                    No jobs found.
                  </td>
                </tr>
              ) : (
                rows.map((j) => (
                  <tr
                    key={`${j.queue}:${j.id}`}
                    className="border-b border-line last:border-0 hover:bg-surface-2/40"
                  >
                    <td className="px-5 py-3 font-mono text-xs text-accent/90">{j.id}</td>
                    <td className="px-5 py-3 text-fg">{j.name || 'unknown'}</td>
                    <td className="px-5 py-3 font-mono text-xs text-muted">{j.queue}</td>
                    <td className="px-5 py-3">
                      <StatusBadge status={String(j.state ?? j.status ?? 'waiting')} />
                    </td>
                    <td className="px-5 py-3 text-right tnum text-muted">{j.priority ?? 0}</td>
                    <td className="px-5 py-3 text-right text-faint">
                      {formatRelativeTime(j.createdAt)}
                    </td>
                    <td className="px-5 py-3 text-right tnum text-muted">
                      {formatDuration(jobDuration(j.processedOn, j.finishedOn))}
                    </td>
                    <td className="px-5 py-3 text-right">
                      <IconButton aria-label="Cancel job" onClick={() => cancel(j.id)}>
                        <IconTrash className="size-3.5" />
                      </IconButton>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
