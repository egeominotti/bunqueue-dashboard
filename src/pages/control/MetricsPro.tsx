import { useMemo, useState } from 'react';
import { AreaChart } from '@/components/ui/AreaChart';
import { Card, CardHeader } from '@/components/ui/Card';
import { LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { StatCard } from '@/components/ui/StatCard';
import { bq } from '@/lib/bq';
import { cn } from '@/lib/cn';
import { errorRate, formatNumber, formatPercent, formatUptime } from '@/lib/format';
import { usePolledData } from '@/lib/usePolledData';
import { depthTrend, useThroughputSeries } from '@/lib/useThroughputSeries';

const compact = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);

const X_LABELS = ['-60s', '-45s', '-30s', '-15s', 'now'];
const PAGE_SIZE = 15;
const OPS = ['push', 'pull', 'ack'] as const;

// Safe zeroed overview so the page renders its full layout when the server is
// unreachable (down, or embedded with no HTTP) instead of a blocking error.
const EMPTY_OVERVIEW = {
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
  latency: {
    averages: {} as Record<string, number>,
    percentiles: {} as Record<string, { p50: number; p95: number; p99: number }>,
  },
};

export function MetricsPro() {
  const series = useThroughputSeries(60);
  const [page, setPage] = useState(0);
  const { data, error, loading, refetch } = usePolledData(async () => {
    // Only /queues/summary here — the live overview (stats/throughput/latency)
    // comes from the 1s sampler below, so /dashboard isn't polled twice.
    const summary = await bq.queuesSummary();
    return { details: summary };
  }, []);

  const details = data?.details ?? [];
  const pageCount = Math.max(1, Math.ceil(details.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = useMemo(
    () => details.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE),
    [details, safePage]
  );

  if (loading && !data && !error) return <LoadingState label="Loading metrics…" />;

  const { stats, throughput, latency } = series.latest ?? EMPTY_OVERVIEW;
  const rate = errorRate(stats.totalCompleted, stats.totalFailed);
  const trend = depthTrend(series.depth);
  const depthNow = series.depth.length ? series.depth[series.depth.length - 1] : 0;

  return (
    <div>
      <PageHeader
        title="Metrics"
        description="Real-time performance telemetry for your queues."
        live
      />
      {error && <OfflineBanner onRetry={refetch} />}

      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard
          label="Total Completed"
          value={compact(stats.totalCompleted)}
          tone="green"
          hint="all time"
        />
        <StatCard
          label="Total Failed"
          value={formatNumber(stats.totalFailed)}
          tone="red"
          hint="all time"
        />
        <StatCard
          label="Push/sec"
          value={throughput.pushPerSec.toFixed(1)}
          tone="accent"
          hint="jobs/sec"
        />
        <StatCard
          label="Pull/sec"
          value={throughput.pullPerSec.toFixed(1)}
          tone="accent"
          hint="jobs/sec"
        />
      </div>

      <Card className="mb-6">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-fg">Live Throughput</h3>
            <p className="text-xs text-faint">Real-time jobs per second (rolling 60s window)</p>
          </div>
          <div className="flex flex-wrap items-center gap-4 font-mono text-[11px] text-faint">
            <Legend color="#ec4899" label="Pushed" value={throughput.pushPerSec} />
            <Legend color="#34d399" label="Completed" value={throughput.completePerSec} />
            <Legend color="#f87171" label="Failed" value={throughput.failPerSec} />
          </div>
        </div>
        <AreaChart
          xLabels={X_LABELS}
          series={[
            { label: 'Pushed', color: '#ec4899', points: series.push, area: true },
            { label: 'Completed', color: '#34d399', points: series.complete },
            { label: 'Failed', color: '#f87171', points: series.fail },
          ]}
        />
      </Card>

      <Card className="mb-6">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-fg">Queue Depth</h3>
            <p className="text-xs text-faint">
              Backlog over time (waiting + active + delayed). The trend says whether you're draining
              or falling behind — more useful than any single gauge.
            </p>
          </div>
          <div className="text-right">
            <div className="tnum text-2xl font-bold text-fg">{formatNumber(depthNow)}</div>
            <div
              className={cn(
                'text-xs font-medium',
                trend.label === 'draining'
                  ? 'text-emerald-400'
                  : trend.label === 'accumulating'
                    ? 'text-red-400'
                    : 'text-faint'
              )}
            >
              {trend.label === 'steady'
                ? 'steady'
                : `${trend.slope > 0 ? '+' : ''}${trend.slope.toFixed(1)}/s · ${trend.label}`}
            </div>
          </div>
        </div>
        <AreaChart
          xLabels={X_LABELS}
          series={[
            {
              label: 'Depth',
              color: trend.draining ? '#34d399' : '#f59e0b',
              points: series.depth,
              area: true,
            },
          ]}
        />
      </Card>

      <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Error Rate" />
          <p className="-mt-3 mb-4 text-xs text-faint">Failed as percentage of total processed</p>
          <div className="flex items-center justify-around">
            <div className="text-center">
              <div
                className={cn('text-3xl font-bold tnum', rate > 0.05 ? 'text-red-400' : 'text-fg')}
              >
                {formatPercent(rate)}
              </div>
              <div className="text-xs text-faint">error rate</div>
            </div>
            <div className="text-center">
              <div className="text-3xl font-bold tnum text-emerald-400">
                {formatPercent(1 - rate)}
              </div>
              <div className="text-xs text-faint">success rate</div>
            </div>
          </div>
          <div className="mt-4 h-2 overflow-hidden rounded-full bg-red-500/40">
            <div
              className="h-full rounded-full bg-emerald-500"
              style={{ width: `${(1 - rate) * 100}%` }}
            />
          </div>
          <div className="mt-2 flex justify-between font-mono text-[11px] text-faint">
            <span>{compact(stats.totalCompleted)} completed</span>
            <span>{formatNumber(stats.totalFailed)} failed</span>
          </div>
        </Card>

        <Card>
          <CardHeader title="Server Overview" />
          <p className="-mt-3 mb-4 text-xs text-faint">Current server-wide statistics</p>
          <dl className="divide-y divide-line text-sm">
            <SrvRow color="bg-blue-400" label="Queued" value={formatNumber(stats.waiting)} />
            <SrvRow color="bg-accent" label="Processing" value={formatNumber(stats.active)} />
            <SrvRow color="bg-amber-400" label="Delayed" value={formatNumber(stats.delayed)} />
            <SrvRow color="bg-red-400" label="Dead Letter" value={formatNumber(stats.dlq)} />
            <SrvRow color="bg-zinc-500" label="Total Pushed" value={compact(stats.totalPushed)} />
            <SrvRow color="bg-zinc-500" label="Total Pulled" value={compact(stats.totalPulled)} />
            {/* stats.uptime is milliseconds; formatUptime expects seconds. */}
            <SrvRow
              color="bg-emerald-400"
              label="Uptime"
              value={formatUptime(stats.uptime / 1000)}
            />
          </dl>
        </Card>
      </div>

      <Card className="mb-6" padded={false}>
        <div className="border-b border-line px-5 py-4">
          <h3 className="text-base font-semibold text-fg">Operation Latency</h3>
          <p className="text-xs text-faint">
            TCP round-trip per operation (p50 / p95 / p99, milliseconds)
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-faint">
                <th className="px-5 py-3 font-medium">Operation</th>
                <th className="px-5 py-3 text-right font-medium">Avg</th>
                <th className="px-5 py-3 text-right font-medium">p50</th>
                <th className="px-5 py-3 text-right font-medium">p95</th>
                <th className="px-5 py-3 text-right font-medium">p99</th>
              </tr>
            </thead>
            <tbody>
              {OPS.map((op) => {
                const p = latency?.percentiles?.[op];
                const avg = latency?.averages?.[`${op}Ms`];
                return (
                  <tr key={op} className="border-b border-line last:border-0">
                    <td className="px-5 py-3 font-medium capitalize text-fg">{op}</td>
                    <td className="px-5 py-3 text-right tnum text-muted">{fmtMs(avg)}</td>
                    <td className="px-5 py-3 text-right tnum text-muted">{fmtMs(p?.p50)}</td>
                    <td className="px-5 py-3 text-right tnum text-muted">{fmtMs(p?.p95)}</td>
                    <td className="px-5 py-3 text-right tnum text-amber-400">{fmtMs(p?.p99)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Card padded={false}>
        <div className="border-b border-line px-5 py-4">
          <h3 className="text-base font-semibold text-fg">Per-Queue Metrics</h3>
          <p className="text-xs text-faint">Job counts breakdown by queue</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-faint">
                <th className="px-5 py-3 font-medium">Queue</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 text-right font-medium">Waiting</th>
                <th className="px-5 py-3 text-right font-medium">Active</th>
                <th className="px-5 py-3 text-right font-medium">Completed</th>
                <th className="px-5 py-3 text-right font-medium">Failed</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-5 py-12 text-center text-sm text-faint">
                    No queues yet.
                  </td>
                </tr>
              ) : (
                pageRows.map((d) => (
                  <tr
                    key={d.name}
                    className="border-b border-line last:border-0 hover:bg-surface-2/40"
                  >
                    <td className="px-5 py-3 font-mono text-xs text-accent">{d.name}</td>
                    <td className="px-5 py-3">
                      <span
                        className={cn(
                          'rounded-full px-2 py-0.5 text-[11px] font-medium',
                          d.paused
                            ? 'bg-orange-500/10 text-orange-400'
                            : 'bg-emerald-500/10 text-emerald-400'
                        )}
                      >
                        {d.paused ? 'paused' : 'active'}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-right tnum text-amber-400">
                      {formatNumber(d.counts.waiting)}
                    </td>
                    <td className="px-5 py-3 text-right tnum text-blue-400">
                      {formatNumber(d.counts.active)}
                    </td>
                    <td className="px-5 py-3 text-right tnum text-emerald-400">
                      {formatNumber(d.counts.completed)}
                    </td>
                    <td className="px-5 py-3 text-right tnum text-red-400">
                      {formatNumber(d.counts.failed)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="px-5 pb-4">
          <Pagination
            page={safePage}
            pageSize={PAGE_SIZE}
            total={details.length}
            onPageChange={setPage}
            label="queues"
          />
        </div>
      </Card>
    </div>
  );
}

function fmtMs(v: number | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${v < 10 ? v.toFixed(1) : Math.round(v)}ms`;
}

function Legend({ color, label, value }: { color: string; label: string; value: number }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="size-2 rounded-full" style={{ background: color }} />
      {label} <span className="text-fg">{value.toFixed(1)}/s</span>
    </span>
  );
}

function SrvRow({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-2.5">
      <dt className="flex items-center gap-2 text-muted">
        <span className={cn('size-2 rounded-full', color)} />
        {label}
      </dt>
      <dd className="font-semibold tnum text-fg">{value}</dd>
    </div>
  );
}
