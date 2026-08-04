import { AreaChart } from '@/components/ui/AreaChart';
import { Card, CardHeader } from '@/components/ui/Card';
import { StatCard } from '@/components/ui/StatCard';
import { cn } from '@/lib/cn';
import { formatBytes, formatMs, formatNumber } from '@/lib/format';
import type { RunConfig, Summary } from './engine';
import { fmtRate } from './engine';
import type { Live } from './useBenchmark';

export function BenchmarkResults({
  heading,
  pollBaseUrl,
  etaText,
  shown,
  shownWorkers,
  producePct,
  drainPct,
  durationPct,
  live,
  summary,
}: {
  heading: string;
  pollBaseUrl: string;
  etaText: string;
  shown: RunConfig;
  shownWorkers: number;
  producePct: number;
  drainPct: number;
  durationPct: number;
  live: Live;
  summary: Summary | null;
}) {
  return (
    <div className="flex flex-col gap-6 lg:col-span-2">
      <Card>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-base font-semibold text-fg">{heading}</h3>
          <span className="text-right text-xs text-faint">
            <span className="block">Benchmark target: {pollBaseUrl}</span>
            {etaText && <span className="block">{etaText}</span>}
          </span>
        </div>
        <ProgressBar
          label={shown.mode === 'duration' ? 'Elapsed' : 'Produced'}
          pct={shown.mode === 'duration' ? durationPct : producePct}
          tone="accent"
        />
        {shownWorkers > 0 && shown.mode === 'count' && (
          <ProgressBar label="Completed" pct={drainPct} tone="emerald" />
        )}
        <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-4">
          <StatCard label="Pushed" value={formatNumber(live.pushed)} tone="accent" compact />
          <StatCard label="Completed" value={formatNumber(live.completed)} tone="green" compact />
          <StatCard label="Push/sec" value={fmtRate(live.pushPerSec)} compact />
          <StatCard label="Done/sec" value={fmtRate(live.donePerSec)} tone="green" compact />
          <StatCard label="Elapsed" value={formatMs(live.elapsedMs)} compact />
          <StatCard
            label="Active workers"
            value={`${live.activeWorkers}/${shownWorkers}`}
            tone="blue"
            compact
          />
          <StatCard label="Data" value={formatBytes(summary?.bytes ?? live.bytes)} compact />
          <StatCard
            label="Errors"
            value={formatNumber(
              (summary?.pushFailed ?? live.pushFailed) + (summary?.ackFailed ?? live.ackFailed)
            )}
            tone={live.pushFailed + live.ackFailed ? 'red' : 'default'}
            compact
          />
        </div>
      </Card>
      <Card>
        <CardHeader title="Throughput" />
        <p className="-mt-3 mb-4 text-xs text-faint">
          Enqueue (client → server) vs completion (workers) per second
        </p>
        <AreaChart
          series={[
            { label: 'Push/sec', color: '#38bdf8', points: live.pushSeries, area: true },
            { label: 'Done/sec', color: '#34d399', points: live.doneSeries, area: true },
          ]}
        />
        <div className="mt-2 flex items-center gap-4 font-mono text-[11px] text-faint">
          <Legend color="#38bdf8" label="Push/sec" value={live.pushPerSec} />
          <Legend color="#34d399" label="Done/sec" value={live.donePerSec} />
        </div>
      </Card>
    </div>
  );
}

export function BenchmarkSummary({ summary }: { summary: Summary | null }) {
  if (!summary) return null;
  return (
    <Card className="mt-6">
      <CardHeader title="Summary" />
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4 xl:grid-cols-8">
        <StatCard label="Pushed" value={formatNumber(summary.pushed)} tone="accent" compact />
        <StatCard label="Completed" value={formatNumber(summary.completed)} tone="green" compact />
        <StatCard label="Duration" value={formatMs(summary.durationMs)} compact />
        <StatCard label="Avg push/s" value={fmtRate(summary.pushPerSec)} tone="accent" compact />
        <StatCard label="Avg done/s" value={fmtRate(summary.donePerSec)} tone="green" compact />
        <StatCard label="Data rate" value={`${formatBytes(summary.mbPerSec)}/s`} compact />
        <StatCard label="Push p95" value={formatMs(summary.p95)} compact />
        <StatCard label="Push p99" value={formatMs(summary.p99)} compact />
      </div>
      <p className="mt-3 text-xs text-faint">
        Push-batch latency avg {formatMs(summary.avg)} · p50 {formatMs(summary.p50)} · p95{' '}
        {formatMs(summary.p95)} · p99 {formatMs(summary.p99)} · max {formatMs(summary.max)}.
        {summary.error ? ` First error: ${summary.error}` : ''}
      </p>
    </Card>
  );
}

export function BenchmarkQueueCounts({
  pollQueue,
  pollBaseUrl,
  pinned,
  counts,
  error,
}: {
  pollQueue: string;
  pollBaseUrl: string;
  pinned: boolean;
  counts: Record<string, number> | null;
  error: Error | null;
}) {
  return (
    <Card className="mt-6">
      <CardHeader
        title={`Server queue: ${pollQueue}`}
        action={
          error ? (
            <span className="text-xs font-medium text-warning">stale — server unreachable</span>
          ) : undefined
        }
      />
      <p className="-mt-3 mb-4 text-xs text-faint">
        Live counts from {pollBaseUrl} (poll 1s).
        {pinned ? ' Pinned to the current or last benchmark run.' : ''}
      </p>
      {counts ? (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
          <StatCard
            label="Waiting"
            value={formatNumber(counts.waiting ?? 0)}
            tone="amber"
            compact
          />
          <StatCard label="Active" value={formatNumber(counts.active ?? 0)} tone="blue" compact />
          <StatCard
            label="Completed"
            value={formatNumber(counts.completed ?? 0)}
            tone="green"
            compact
          />
          <StatCard
            label="Failed"
            value={formatNumber(counts.failed ?? 0)}
            tone={counts.failed ? 'red' : 'default'}
            compact
          />
          <StatCard label="Delayed" value={formatNumber(counts.delayed ?? 0)} compact />
        </div>
      ) : (
        <p className="text-sm text-faint">
          No counts yet — waiting for the server to answer for this queue.
        </p>
      )}
    </Card>
  );
}

function ProgressBar({
  label,
  pct,
  tone,
}: {
  label: string;
  pct: number;
  tone: 'accent' | 'emerald';
}) {
  return (
    <div className="mb-2">
      <div className="mb-1 flex items-center justify-between text-[11px] text-faint">
        <span>{label}</span>
        <span className="tnum">{pct.toFixed(0)}%</span>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-surface-2"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
      >
        <div
          className={cn(
            'h-full rounded-full transition-[width] motion-reduce:transition-none',
            tone === 'accent' ? 'bg-accent' : 'bg-emerald-500'
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function Legend({ color, label, value }: { color: string; label: string; value: number }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="size-2 rounded-full" style={{ background: color }} />
      {label} <span className="text-fg">{fmtRate(value)}/s</span>
    </span>
  );
}
