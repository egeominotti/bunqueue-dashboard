import { type ChangeEvent, useState } from 'react';
import { AreaChart } from '@/components/ui/AreaChart';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Field, Input, SegmentedControl, Toggle } from '@/components/ui/form';
import { IconPause, IconPlay } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatCard } from '@/components/ui/StatCard';
import { bq } from '@/lib/bq';
import { cn } from '@/lib/cn';
import { formatNumber } from '@/lib/format';
import { usePolledData } from '@/lib/usePolledData';
import {
  clampInt,
  DEFAULT_CONFIG,
  fmtBytes,
  fmtMs,
  fmtRate,
  LIMITS,
  PRESETS,
  type RunConfig,
  type RunMode,
} from './benchmark/engine';
import { RunHistory } from './benchmark/RunHistory';
import { useBenchmark } from './benchmark/useBenchmark';

const MODES: readonly RunMode[] = ['count', 'duration'] as const;

export function Benchmark() {
  const [cfg, setCfg] = useState<RunConfig>(DEFAULT_CONFIG);
  const bench = useBenchmark();
  const { phase, live, summary, history } = bench;
  const active = phase === 'running' || phase === 'draining';

  const set = <K extends keyof RunConfig>(k: K, v: RunConfig[K]) =>
    setCfg((c) => ({ ...c, [k]: v }));
  const num =
    <K extends keyof RunConfig>(k: K) =>
    (e: ChangeEvent<HTMLInputElement>) =>
      set(k, Number(e.target.value) as RunConfig[K]);

  // Live server-side queue depth — proof the load lands and drains.
  const { data: counts } = usePolledData(
    () => bq.counts(cfg.queue.trim() || 'benchmark').catch(() => null),
    [cfg.queue],
    { intervalMs: 1000 }
  );
  const c = counts?.counts ?? null;

  const cleanup = async () => {
    const q = cfg.queue.trim();
    if (!q || !window.confirm(`Remove benchmark jobs from "${q}"?`)) return;
    for (const state of ['waiting', 'completed', 'failed', 'delayed']) {
      try {
        await bq.clean(q, { state, limit: LIMITS.total });
      } catch {
        /* state not cleanable */
      }
    }
  };

  const total = clampInt(cfg.total, 1, LIMITS.total);
  const producePct = cfg.mode === 'count' ? Math.min(100, (live.pushed / total) * 100) : 0;
  const drainPct = cfg.mode === 'count' ? Math.min(100, (live.completed / total) * 100) : 0;
  const durationPct =
    cfg.mode === 'duration'
      ? Math.min(
          100,
          (live.elapsedMs / (clampInt(cfg.durationS, 1, LIMITS.durationS) * 1000)) * 100
        )
      : 0;

  return (
    <div>
      <PageHeader
        title="Benchmark"
        description="Drive real load against the server — producers bulk-enqueue jobs while simulated workers pull, process and ack them. Throughput is measured client-side; the queue genuinely fills and drains."
        actions={
          active ? (
            <Button variant="warning" size="sm" onClick={bench.stop}>
              <IconPause className="size-3.5" /> Stop
            </Button>
          ) : (
            <Button variant="success" size="sm" onClick={() => bench.run(cfg)}>
              <IconPlay className="size-3.5" /> Run benchmark
            </Button>
          )
        }
      />

      {live.error && (
        <div className="mb-4 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-2 text-sm text-red-400">
          {live.error}
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium uppercase tracking-wider text-faint">Presets</span>
        {Object.keys(PRESETS).map((name) => (
          <button
            key={name}
            type="button"
            disabled={active}
            onClick={() => setCfg((prev) => ({ ...prev, ...PRESETS[name] }))}
            className="rounded-md border border-line bg-surface-2 px-2.5 py-1 text-xs text-muted transition-colors hover:border-line-strong hover:text-fg disabled:opacity-40"
          >
            {name}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader title="Configuration" />
          <div className="flex flex-col gap-3">
            <Field label="Queue" hint="Jobs are enqueued here (created on first push).">
              <Input
                value={cfg.queue}
                disabled={active}
                onChange={(e) => set('queue', e.target.value)}
              />
            </Field>

            <Field
              label="Mode"
              hint={
                cfg.mode === 'count'
                  ? 'Push a fixed number of jobs.'
                  : 'Run producers + workers for a fixed time.'
              }
            >
              <SegmentedControl options={MODES} value={cfg.mode} onChange={(m) => set('mode', m)} />
            </Field>

            {cfg.mode === 'count' ? (
              <Field label="Total jobs" hint={`max ${formatNumber(LIMITS.total)}`}>
                <Input type="number" value={cfg.total} disabled={active} onChange={num('total')} />
              </Field>
            ) : (
              <Field label="Duration (s)" hint={`max ${LIMITS.durationS}s`}>
                <Input
                  type="number"
                  value={cfg.durationS}
                  disabled={active}
                  onChange={num('durationS')}
                />
              </Field>
            )}

            <div className="mt-1 text-[11px] font-semibold uppercase tracking-wider text-faint">
              Producers
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Producers" hint={`parallel, max ${LIMITS.producers}`}>
                <Input
                  type="number"
                  value={cfg.producers}
                  disabled={active}
                  onChange={num('producers')}
                />
              </Field>
              <Field label="Push batch" hint={`jobs/req, max ${LIMITS.batch}`}>
                <Input type="number" value={cfg.batch} disabled={active} onChange={num('batch')} />
              </Field>
              <Field label="Payload" hint={`bytes/job, max ${formatNumber(LIMITS.payload)}`}>
                <Input
                  type="number"
                  value={cfg.payload}
                  disabled={active}
                  onChange={num('payload')}
                />
              </Field>
            </div>

            <div className="mt-1 text-[11px] font-semibold uppercase tracking-wider text-faint">
              Workers (simulated)
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Workers" hint={`0 = produce only, max ${LIMITS.workers}`}>
                <Input
                  type="number"
                  value={cfg.workers}
                  disabled={active}
                  onChange={num('workers')}
                />
              </Field>
              <Field label="Pull batch" hint={`jobs/pull, max ${LIMITS.workerBatch}`}>
                <Input
                  type="number"
                  value={cfg.workerBatch}
                  disabled={active}
                  onChange={num('workerBatch')}
                />
              </Field>
              <Field label="Process (ms)" hint="simulated work per pull">
                <Input
                  type="number"
                  value={cfg.processMs}
                  disabled={active}
                  onChange={num('processMs')}
                />
              </Field>
            </div>

            <Toggle
              checked={cfg.durable}
              onChange={(v) => set('durable', v)}
              label="Durable (fsync each job)"
            />
            <Toggle
              checked={cfg.removeOnComplete}
              onChange={(v) => set('removeOnComplete', v)}
              label="Remove on complete"
            />

            <div className="pt-1">
              <Button variant="ghost" size="sm" disabled={active} onClick={cleanup}>
                Clean queue
              </Button>
            </div>
          </div>
        </Card>

        <div className="flex flex-col gap-6 lg:col-span-2">
          <Card>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-base font-semibold text-fg">
                {phase === 'running'
                  ? 'Producing…'
                  : phase === 'draining'
                    ? 'Draining…'
                    : summary
                      ? 'Result'
                      : 'Ready'}
              </h3>
              <span className="text-xs text-faint">
                {live.etaMs != null && active ? `ETA ${fmtMs(live.etaMs)}` : ''}
                {phase === 'stopped' ? 'stopped early' : ''}
                {phase === 'done' ? 'complete' : ''}
              </span>
            </div>

            <ProgressBar
              label="Produced"
              pct={cfg.mode === 'duration' ? durationPct : producePct}
              tone="accent"
            />
            {cfg.workers > 0 && cfg.mode === 'count' && (
              <ProgressBar label="Completed" pct={drainPct} tone="emerald" />
            )}

            <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-4">
              <StatCard label="Pushed" value={formatNumber(live.pushed)} tone="accent" compact />
              <StatCard
                label="Completed"
                value={formatNumber(live.completed)}
                tone="green"
                compact
              />
              <StatCard
                label="Push/sec"
                value={`${fmtRate(summary?.pushPerSec ?? live.pushPerSec)}`}
                compact
              />
              <StatCard
                label="Done/sec"
                value={`${fmtRate(summary?.donePerSec ?? live.donePerSec)}`}
                tone="green"
                compact
              />
              <StatCard label="Elapsed" value={fmtMs(live.elapsedMs)} compact />
              <StatCard
                label="Active workers"
                value={`${live.activeWorkers}/${cfg.workers}`}
                tone="blue"
                compact
              />
              <StatCard label="Data" value={fmtBytes(summary?.bytes ?? live.bytes)} compact />
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
      </div>

      {summary && (
        <Card className="mt-6">
          <CardHeader title="Summary" />
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4 xl:grid-cols-8">
            <StatCard label="Pushed" value={formatNumber(summary.pushed)} tone="accent" compact />
            <StatCard
              label="Completed"
              value={formatNumber(summary.completed)}
              tone="green"
              compact
            />
            <StatCard label="Duration" value={fmtMs(summary.durationMs)} compact />
            <StatCard
              label="Avg push/s"
              value={fmtRate(summary.pushPerSec)}
              tone="accent"
              compact
            />
            <StatCard label="Avg done/s" value={fmtRate(summary.donePerSec)} tone="green" compact />
            <StatCard label="Data rate" value={`${fmtBytes(summary.mbPerSec)}/s`} compact />
            <StatCard label="Push p95" value={fmtMs(summary.p95)} compact />
            <StatCard label="Push p99" value={fmtMs(summary.p99)} compact />
          </div>
          <p className="mt-3 text-xs text-faint">
            Push-batch latency avg {fmtMs(summary.avg)} · p50 {fmtMs(summary.p50)} · p95{' '}
            {fmtMs(summary.p95)} · p99 {fmtMs(summary.p99)} · max {fmtMs(summary.max)}.
            {summary.error ? ` First error: ${summary.error}` : ''}
          </p>
        </Card>
      )}

      {c && (
        <Card className="mt-6">
          <CardHeader title={`Server queue: ${cfg.queue.trim()}`} />
          <p className="-mt-3 mb-4 text-xs text-faint">Live counts from the server (poll 1s).</p>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
            <StatCard label="Waiting" value={formatNumber(c.waiting ?? 0)} tone="amber" compact />
            <StatCard label="Active" value={formatNumber(c.active ?? 0)} tone="blue" compact />
            <StatCard
              label="Completed"
              value={formatNumber(c.completed ?? 0)}
              tone="green"
              compact
            />
            <StatCard
              label="Failed"
              value={formatNumber(c.failed ?? 0)}
              tone={c.failed ? 'red' : 'default'}
              compact
            />
            <StatCard label="Delayed" value={formatNumber(c.delayed ?? 0)} compact />
          </div>
        </Card>
      )}

      <RunHistory history={history} onClear={bench.clearHistory} />
    </div>
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
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
        <div
          className={cn(
            'h-full rounded-full transition-all',
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
