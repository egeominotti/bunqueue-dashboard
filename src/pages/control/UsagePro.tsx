import { Card, CardHeader } from '@/components/ui/Card';
import { LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatCard } from '@/components/ui/StatCard';
import { bq } from '@/lib/bq';
import type { StorageStatusFlat } from '@/lib/bqTypes';
import {
  errorRate,
  formatBytes,
  formatNumber,
  formatPercent,
  formatRelativeTime,
  formatUptime,
} from '@/lib/format';
import { usePolledData } from '@/lib/usePolledData';

// Safe zeroed shape so the page renders its full layout when the server is
// unreachable (down, or embedded with no HTTP) instead of a blocking error.
const EMPTY = {
  overview: {
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
    crons: { total: 0 },
  },
  storage: {} as StorageStatusFlat,
};

export function UsagePro() {
  const { data, error, loading, refetch } = usePolledData(async () => {
    // /storage is the honest disk-health source ({ ok, data: { diskFull, … } });
    // the /dashboard storage blob is what the classic page misread.
    const [overview, storage] = await Promise.all([bq.overview(), bq.storage()]);
    return { overview, storage: storage.data ?? ({} as StorageStatusFlat) };
  }, []);

  if (loading && !data && !error) return <LoadingState label="Loading usage…" />;

  const d = data ?? EMPTY;
  const { stats, memory, crons } = d.overview;
  const { storage } = d;
  const rate = errorRate(stats.totalCompleted, stats.totalFailed);
  // stats.uptime from /dashboard is milliseconds; formatUptime expects seconds.
  const uptime = stats.uptime ? formatUptime(stats.uptime / 1000) : '—';

  return (
    <div>
      <PageHeader
        title="Usage"
        description="Cumulative resource usage on the connected server."
        live
      />
      {error && <OfflineBanner onRetry={refetch} />}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Completed" value={formatNumber(stats.totalCompleted)} tone="green" />
        <StatCard
          label="Failed"
          value={formatNumber(stats.totalFailed)}
          tone={stats.totalFailed ? 'red' : 'default'}
        />
        <StatCard label="Waiting" value={formatNumber(stats.waiting)} tone="amber" />
        <StatCard label="Active" value={formatNumber(stats.active)} tone="blue" />
        <StatCard
          label="Error Rate"
          value={formatPercent(rate)}
          tone={rate > 0.05 ? 'red' : 'green'}
        />
        <StatCard label="Uptime" value={uptime} />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Runtime" />
          <dl className="divide-y divide-line text-sm">
            <Row label="Jobs pushed" value={formatNumber(stats.totalPushed)} />
            <Row label="Jobs pulled" value={formatNumber(stats.totalPulled)} />
            <Row label="Heap used" value={formatBytes(memory.heapUsed * 1024 * 1024)} />
            <Row label="RSS" value={formatBytes(memory.rss * 1024 * 1024)} />
            <Row label="Cron jobs" value={String(crons.total)} />
          </dl>
        </Card>
        <Card>
          <CardHeader title="Storage" />
          {storage.diskFull ? (
            <div className="rounded-lg border border-red-500/25 bg-red-500/[0.06] px-4 py-3">
              <div className="font-semibold text-danger">Disk full — writes suspended</div>
              {storage.error && <div className="mt-1 text-xs text-muted">{storage.error}</div>}
              {storage.since != null && (
                <div className="mt-1 text-xs text-faint">
                  since {formatRelativeTime(storage.since)}
                </div>
              )}
            </div>
          ) : (
            <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/[0.06] px-4 py-3">
              <div className="font-semibold text-success">Healthy</div>
              <div className="mt-1 text-xs text-faint">Disk writes are being accepted.</div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-2.5">
      <dt className="text-muted">{label}</dt>
      <dd className="font-medium text-fg">{value}</dd>
    </div>
  );
}
