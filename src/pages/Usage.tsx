import { Card, CardHeader } from '@/components/ui/Card';
import { LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatCard } from '@/components/ui/StatCard';
import { api } from '@/lib/api';
import { formatBytes, formatNumber, formatRelativeTime, formatUptime } from '@/lib/format';
import type { StorageStatus } from '@/lib/types';
import { usePolledData } from '@/lib/usePolledData';

// Safe zeroed shape so the page renders its full layout when the server is
// unreachable (down, or embedded with no HTTP) instead of a blocking error.
const EMPTY = {
  stats: {
    waiting: 0,
    active: 0,
    delayed: 0,
    completed: 0,
    dlq: 0,
    totalPushed: 0,
    totalPulled: 0,
    totalCompleted: 0,
    totalFailed: 0,
    uptime: 0,
  },
  memory: { heapUsed: 0, heapTotal: 0, rss: 0 },
  workers: { total: 0, active: 0 },
  crons: { total: 0 },
  storage: {} as StorageStatus,
};

export function Usage() {
  const { data, error, loading, refetch } = usePolledData(() => api.overview(), []);

  if (loading && !data && !error) return <LoadingState label="Loading usage…" />;

  const d = data ?? EMPTY;
  const { stats, memory, workers, crons, storage } = d;

  return (
    <div>
      <PageHeader
        title="Usage"
        description="Cumulative resource usage on the connected server."
        live
      />
      {error && <OfflineBanner onRetry={refetch} />}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label="Jobs Pushed" value={formatNumber(stats.totalPushed)} />
        <StatCard label="Jobs Completed" value={formatNumber(stats.totalCompleted)} tone="green" />
        <StatCard
          label="Jobs Failed"
          value={formatNumber(stats.totalFailed)}
          tone={stats.totalFailed ? 'red' : 'default'}
        />
        <StatCard label="Jobs Pulled" value={formatNumber(stats.totalPulled)} tone="blue" />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Runtime" />
          <dl className="divide-y divide-line text-sm">
            <Row label="Uptime" value={formatUptime(stats.uptime / 1000)} />
            <Row label="Heap used" value={formatBytes(memory.heapUsed * 1024 * 1024)} />
            <Row label="RSS" value={formatBytes(memory.rss * 1024 * 1024)} />
            <Row label="Workers" value={`${workers.active} active / ${workers.total}`} />
            <Row label="Cron jobs" value={String(crons.total)} />
          </dl>
        </Card>
        <Card>
          <CardHeader title="Storage" />
          <dl className="divide-y divide-line text-sm">
            <Row label="Status" value={storage.diskFull ? 'Disk full' : 'Healthy'} />
            <Row
              label="Disk full since"
              value={storage.diskFull ? formatRelativeTime(storage.since) : '—'}
            />
            {storage.error ? <Row label="Error" value={String(storage.error)} /> : null}
          </dl>
        </Card>
      </div>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between py-2.5">
      <dt className="text-muted">{label}</dt>
      <dd className={mono ? 'font-mono text-xs text-fg' : 'font-medium text-fg'}>{value}</dd>
    </div>
  );
}
