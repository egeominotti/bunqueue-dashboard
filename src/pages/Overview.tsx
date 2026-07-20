import { Card, CardHeader } from '@/components/ui/Card';
import { LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { IconCron, IconWorkers } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatCard } from '@/components/ui/StatCard';
import { api } from '@/lib/api';
import { errorRate, formatBytes, formatNumber, formatPercent, formatUptime } from '@/lib/format';
import type { OverviewResponse } from '@/lib/types';
import { usePolledData } from '@/lib/usePolledData';

const EMPTY: OverviewResponse = {
  ok: false,
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
  throughput: { pushPerSec: 0, pullPerSec: 0, completePerSec: 0, failPerSec: 0 },
  latency: { averages: {}, percentiles: {} },
  memory: { heapUsed: 0, heapTotal: 0, rss: 0 },
  collections: {},
  workers: { total: 0, active: 0, list: [], truncated: false },
  crons: { total: 0, list: [], truncated: false },
  storage: {},
  timestamp: 0,
};

export function Overview() {
  const { data, error, loading, refetch } = usePolledData(() => api.overview(), []);

  if (loading && !data && !error) return <LoadingState label="Loading overview…" />;

  const { stats, throughput, memory, workers, crons, storage } = data ?? EMPTY;
  const rate = errorRate(stats.totalCompleted, stats.totalFailed) ?? 0;

  return (
    <div>
      {error && <OfflineBanner onRetry={refetch} />}
      <PageHeader
        title="Overview"
        description="Live health and throughput across all queues."
        live
      />

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Waiting" value={formatNumber(stats.waiting)} tone="amber" />
        <StatCard label="Active" value={formatNumber(stats.active)} tone="blue" />
        <StatCard label="Completed" value={formatNumber(stats.totalCompleted)} tone="green" />
        <StatCard label="Failed" value={formatNumber(stats.totalFailed)} tone="red" />
        <StatCard
          label="DLQ"
          value={formatNumber(stats.dlq)}
          tone={stats.dlq > 0 ? 'red' : 'default'}
        />
        <StatCard
          label="Error Rate"
          value={formatPercent(rate)}
          tone={rate > 0.05 ? 'red' : 'green'}
        />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Throughput" />
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Rate label="Pushed" value={throughput.pushPerSec} tone="text-fg" />
            <Rate label="Pulled" value={throughput.pullPerSec} tone="text-blue-400" />
            <Rate label="Completed" value={throughput.completePerSec} tone="text-emerald-400" />
            <Rate label="Failed" value={throughput.failPerSec} tone="text-red-400" />
          </div>
        </Card>

        <Card>
          <CardHeader title="Resources" />
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Meta label="Uptime" value={formatUptime(stats.uptime / 1000)} />
            <Meta label="Heap" value={formatBytes(memory.heapUsed * 1024 * 1024)} />
            <Meta label="RSS" value={formatBytes(memory.rss * 1024 * 1024)} />
            <Meta
              label="Storage"
              value={storage.diskFull ? 'Disk full' : 'Healthy'}
              tone={storage.diskFull ? 'text-red-400' : 'text-emerald-400'}
            />
          </div>
        </Card>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Workers"
            icon={<IconWorkers className="size-4 text-faint" />}
            action={
              <span className="text-sm text-muted">
                <span className="font-semibold text-emerald-400">{workers.active}</span> /{' '}
                {workers.total} active
              </span>
            }
          />
          {workers.list.length === 0 ? (
            <p className="py-6 text-center text-sm text-faint">No workers registered.</p>
          ) : (
            <ul className="divide-y divide-line">
              {workers.list.slice(0, 6).map((w) => (
                <li key={w.id} className="flex items-center justify-between py-2 text-sm">
                  <span className="truncate font-medium text-fg">{w.name || w.id}</span>
                  <span className="text-xs text-faint">
                    {w.queues.join(', ') || '—'} · {formatNumber(w.processedJobs)} done
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Cron Jobs"
            icon={<IconCron className="size-4 text-faint" />}
            action={<span className="text-sm text-muted">{crons.total} scheduled</span>}
          />
          {crons.list.length === 0 ? (
            <p className="py-6 text-center text-sm text-faint">No cron jobs.</p>
          ) : (
            <ul className="divide-y divide-line">
              {crons.list.slice(0, 6).map((c) => (
                <li key={c.name} className="flex items-center justify-between py-2 text-sm">
                  <span className="truncate font-medium text-fg">{c.name}</span>
                  <span className="font-mono text-xs text-faint">
                    {c.schedule ?? (c.repeatEvery ? `every ${c.repeatEvery}ms` : '—')}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

function Rate({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div>
      <div className="text-[11px] font-medium uppercase tracking-wider text-faint">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tnum ${tone}`}>
        {value.toFixed(1)}
        <span className="ml-0.5 text-sm font-normal text-faint">/s</span>
      </div>
    </div>
  );
}

function Meta({ label, value, tone = 'text-fg' }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className="text-[11px] font-medium uppercase tracking-wider text-faint">{label}</div>
      <div className={`mt-1 text-base font-semibold ${tone}`}>{value}</div>
    </div>
  );
}
