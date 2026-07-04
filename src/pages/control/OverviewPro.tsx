import { useRef } from 'react';
import { Link } from 'react-router-dom';
import { useConnectionStore } from '@/components/dashboard/stores/connectionStore';
import { Card } from '@/components/ui/Card';
import { LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { IconArrowRight } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatCard } from '@/components/ui/StatCard';
import { bq } from '@/lib/bq';
import { cn } from '@/lib/cn';
import {
  errorRate,
  formatBytes,
  formatCompact,
  formatNumber,
  formatPercent,
  formatRelativeTime,
  formatUptime,
} from '@/lib/format';
import { useActivityStream } from '@/lib/useActivityStream';
import { usePolledData } from '@/lib/usePolledData';

interface QueueHealth {
  name: string;
  paused: boolean;
  counts: { waiting: number; active: number; completed: number; failed: number } | null;
}

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
    throughput: { pushPerSec: 0, pullPerSec: 0, completePerSec: 0, failPerSec: 0 },
    memory: { heapUsed: 0, heapTotal: 0, rss: 0 },
    crons: { total: 0 },
  },
  queuesTotal: 0,
  details: [] as QueueHealth[],
  failedTotal: 0,
};

// Backlog size above which the Waiting card turns amber — a small standing
// queue is normal operation, not a warning.
const WAITING_AMBER_THRESHOLD = 100;

export function OverviewPro() {
  const baseUrl = useConnectionStore((s) => s.baseUrl);
  // Wall-clock time of the last poll that succeeded, so the degraded banner can
  // say how stale the displayed data actually is.
  const lastOkAt = useRef<number | null>(null);

  const { data, error, loading, refetch } = usePolledData(async () => {
    // One /dashboard + one /queues/summary — not an N-queue fan-out. Summary
    // carries every queue's waiting/active/completed/failed counts, so the
    // Queue Health cards need no per-queue queueDetail calls.
    const [overview, summary] = await Promise.all([bq.overview(), bq.queuesSummary()]);
    // Show the WORST queues, not the first six the server happens to list:
    // failed desc, then waiting desc. (Summary carries no per-queue DLQ count,
    // so dlq can't participate in the ranking without an N-queue fan-out.)
    const details: QueueHealth[] = [...summary]
      .sort(
        (a, b) =>
          (b.counts?.failed ?? 0) - (a.counts?.failed ?? 0) ||
          (b.counts?.waiting ?? 0) - (a.counts?.waiting ?? 0)
      )
      .slice(0, 6)
      .map((q) => ({ name: q.name, paused: q.paused, counts: q.counts }));
    // Failed jobs summed across queues — unlike stats.totalFailed (a session
    // counter that resets on every server restart), these are recorded jobs.
    const failedTotal = summary.reduce((a, q) => a + (q.counts?.failed ?? 0), 0);
    lastOkAt.current = Date.now();
    return { overview, queuesTotal: summary.length, details, failedTotal };
  }, []);

  if (loading && !data && !error) return <LoadingState label="Loading overview…" />;

  const d = data ?? EMPTY;
  const { overview, queuesTotal, details, failedTotal } = d;
  const { stats, throughput, memory, crons } = overview;
  // Recorded counts (stats.completed + per-queue failed sums), not the
  // totalCompleted/totalFailed session counters that zero on server restart.
  const rate = errorRate(stats.completed, failedTotal);
  const host = baseUrl === '/api' ? 'localhost:6790' : baseUrl.replace(/^https?:\/\//, '');
  // stats.uptime from /dashboard is milliseconds; formatUptime expects seconds.
  const uptime = stats.uptime ? formatUptime(stats.uptime / 1000) : '—';
  const ram = formatBytes(memory.rss * 1024 * 1024);
  // A truthy `error` means the latest poll failed; we keep rendering the last
  // known (or empty) data instead of a blocking error screen.
  const degraded = !!error;

  return (
    <div>
      <PageHeader title="Overview" description="Real-time system health at a glance." live />
      {error && <OfflineBanner onRetry={refetch} />}

      {/* Connection banner */}
      <div
        className={cn(
          'mb-6 flex flex-wrap items-center justify-between gap-y-2 rounded-xl border px-5 py-4',
          degraded
            ? 'border-amber-500/25 bg-amber-500/[0.06]'
            : 'border-emerald-500/25 bg-emerald-500/[0.06]'
        )}
      >
        <div className="flex min-w-0 items-center gap-3">
          <span className="relative flex size-2.5">
            {!degraded && (
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-60" />
            )}
            <span
              className={cn(
                'relative inline-flex size-2.5 rounded-full',
                degraded ? 'bg-amber-400' : 'bg-emerald-400'
              )}
            />
          </span>
          <div className="min-w-0">
            <div className={cn('font-semibold', degraded ? 'text-warning' : 'text-success')}>
              {degraded ? 'Connection lost — showing last known data' : 'bunqueue server connected'}
            </div>
            <div className="truncate font-mono text-xs text-muted">
              {host} · uptime {uptime} · {ram} RAM
              {degraded && (
                <>
                  {' '}
                  · last updated {lastOkAt.current ? formatRelativeTime(lastOkAt.current) : 'never'}
                </>
              )}
            </div>
          </div>
        </div>
        <span
          className={cn(
            'rounded-full px-3 py-1 text-xs font-medium',
            degraded ? 'bg-amber-500/15 text-warning' : 'bg-emerald-500/15 text-success'
          )}
        >
          {degraded ? 'Stale' : 'Online'}
        </span>
      </div>

      {/* Primary health row — the "is something wrong" signals, full-size cards. */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <StatCard
          label="Error Rate"
          value={rate == null ? '—' : formatPercent(rate)}
          tone={rate == null ? 'default' : rate > 0.05 ? 'red' : 'green'}
          hint="failed / processed"
        />
        <StatCard
          label="Failed"
          value={formatNumber(failedTotal)}
          tone={failedTotal ? 'red' : 'default'}
          hint="recorded across queues"
        />
        <StatCard
          label="DLQ"
          value={formatNumber(stats.dlq)}
          tone={stats.dlq ? 'red' : 'default'}
          hint="dead-lettered jobs"
        />
      </div>

      {/* Secondary row — throughput & inventory, compact. Uptime/RAM live in the
          banner above; the old API Keys card carried no operational signal. */}
      <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Completed" value={formatNumber(stats.completed)} tone="green" compact />
        <StatCard label="Active" value={formatNumber(stats.active)} tone="blue" compact />
        <StatCard
          label="Waiting"
          value={formatNumber(stats.waiting)}
          tone={stats.waiting > WAITING_AMBER_THRESHOLD ? 'amber' : 'default'}
          compact
        />
        <StatCard
          label="Push/sec"
          value={throughput.pushPerSec.toFixed(1)}
          tone="accent"
          hint={`${formatCompact(stats.totalPushed)} since restart`}
          compact
        />
        <StatCard
          label="Pull/sec"
          value={throughput.pullPerSec.toFixed(1)}
          tone="accent"
          hint={`${formatCompact(stats.totalPulled)} since restart`}
          compact
        />
        <StatCard
          label="Queues"
          value={formatNumber(queuesTotal)}
          hint={`${crons.total} cron active`}
          compact
        />
      </div>

      {/* Queue Health — ranked worst-first (see the sort in the fetcher). */}
      <div className="mt-8">
        <SectionHeading title="Queue Health — most loaded" to="/queues" />
        {details.length === 0 ? (
          <Card>
            <p className="py-4 text-center text-sm text-faint">No queues yet.</p>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {details.map((qd) => (
              <Link
                key={qd.name}
                to={`/queues/${encodeURIComponent(qd.name)}`}
                className="rounded-xl border border-line bg-surface p-4 transition-colors hover:border-line-strong"
              >
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-sm font-medium text-accent">
                    {qd.name}
                  </span>
                  <span
                    className={cn(
                      'shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium',
                      qd.paused
                        ? 'bg-orange-500/10 text-orange-400'
                        : 'bg-emerald-500/10 text-success'
                    )}
                  >
                    {qd.paused ? 'paused' : 'active'}
                  </span>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-faint">
                  <Metric label="W" value={qd.counts?.waiting} tone="text-warning" />
                  <Metric label="A" value={qd.counts?.active} tone="text-blue-400" />
                  <Metric label="C" value={qd.counts?.completed} tone="text-success" />
                  <Metric label="F" value={qd.counts?.failed} tone="text-danger" />
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Recent Activity — its own SSE-subscribing leaf so live events re-render
          only this list, not the stat cards / queue-health grid above. */}
      <RecentActivity />
    </div>
  );
}

function RecentActivity() {
  const { events, connected } = useActivityStream();
  return (
    <div className="mt-8">
      <SectionHeading title="Recent Activity" to="/logs" />
      <Card padded={false}>
        {!connected && events.length > 0 && (
          <p className="border-b border-line px-5 py-2 text-xs text-warning">
            Event stream disconnected — reconnecting…
          </p>
        )}
        {events.length === 0 ? (
          <p className="py-8 text-center text-sm text-faint">
            {connected ? 'Waiting for live activity…' : 'Connecting to the event stream…'}
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {events.slice(0, 8).map((e) => (
              <li key={e.seq} className="flex items-center justify-between px-5 py-3">
                <div className="flex items-center gap-3">
                  <span className={cn('size-2 rounded-full', dotFor(e.status))} />
                  <div className="text-sm">
                    <span className="font-mono font-medium text-fg">{e.queue || '—'}</span>
                    <span className="text-faint"> · </span>
                    <span className="font-mono text-xs text-faint">
                      {e.jobId ? e.jobId.slice(0, 8) : '—'}
                    </span>
                    <span className="text-faint"> · </span>
                    <span className="capitalize text-muted">{e.status}</span>
                  </div>
                </div>
                <span className="text-xs text-faint">{formatRelativeTime(e.timestamp)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function SectionHeading({ title, to }: { title: string; to: string }) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <h2 className="text-lg font-semibold text-fg">{title}</h2>
      <Link to={to} className="flex items-center gap-1 text-sm text-muted hover:text-fg">
        View All <IconArrowRight className="size-3.5" />
      </Link>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value?: number; tone: string }) {
  return (
    <span>
      {label}{' '}
      <span className={cn('tnum font-semibold', tone)}>
        {value == null ? '—' : formatNumber(value)}
      </span>
    </span>
  );
}

function dotFor(status: string): string {
  switch (status) {
    case 'completed':
      return 'bg-emerald-400';
    case 'failed':
      return 'bg-red-400';
    case 'active':
      return 'bg-blue-400';
    case 'waiting':
      // Amber, matching the amber Waiting stat cards.
      return 'bg-amber-400';
    default:
      return 'bg-accent';
  }
}
