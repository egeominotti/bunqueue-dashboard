import { type ChangeEvent, useEffect, useState } from 'react';
import { AreaChart } from '@/components/ui/AreaChart';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Field, Input, SegmentedControl, Toggle } from '@/components/ui/form';
import { IconPause, IconPlay } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatCard } from '@/components/ui/StatCard';
import { bq } from '@/lib/bq';
import { cn } from '@/lib/cn';
import { formatBytes, formatMs, formatNumber } from '@/lib/format';
import { usePolledData } from '@/lib/usePolledData';
import {
  clampInt,
  DEFAULT_CONFIG,
  fmtRate,
  LIMITS,
  PRESETS,
  type RunConfig,
  type RunMode,
} from './benchmark/engine';
import { RunHistory } from './benchmark/RunHistory';
import { useBenchmark } from './benchmark/useBenchmark';

const MODES: readonly RunMode[] = ['count', 'duration'] as const;

// Numeric fields are string-backed in the form (so a field can be cleared while
// typing — a controlled type=number with Number() coercion can never be emptied)
// and converted to a RunConfig once, at the Run boundary. run() clamps.
type NumKey =
  | 'total'
  | 'durationS'
  | 'batch'
  | 'producers'
  | 'payload'
  | 'workers'
  | 'workerBatch'
  | 'processMs';
type Draft = Omit<RunConfig, NumKey> & Record<NumKey, string>;

const NUM_KEYS: readonly NumKey[] = [
  'total',
  'durationS',
  'batch',
  'producers',
  'payload',
  'workers',
  'workerBatch',
  'processMs',
] as const;

const toDraft = (c: RunConfig): Draft => ({
  ...c,
  total: String(c.total),
  durationS: String(c.durationS),
  batch: String(c.batch),
  producers: String(c.producers),
  payload: String(c.payload),
  workers: String(c.workers),
  workerBatch: String(c.workerBatch),
  processMs: String(c.processMs),
});

const toConfig = (d: Draft): RunConfig => ({
  ...d,
  total: Number(d.total),
  durationS: Number(d.durationS),
  batch: Number(d.batch),
  producers: Number(d.producers),
  payload: Number(d.payload),
  workers: Number(d.workers),
  workerBatch: Number(d.workerBatch),
  processMs: Number(d.processMs),
});

export function Benchmark() {
  const [draft, setDraft] = useState<Draft>(() => toDraft(DEFAULT_CONFIG));
  const bench = useBenchmark();
  const { phase, live, summary, history } = bench;
  const active = phase === 'running' || phase === 'draining' || phase === 'stopping';

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const num = (k: NumKey) => (e: ChangeEvent<HTMLInputElement>) => set(k, e.target.value);

  const applyPreset = (p: Partial<RunConfig>) =>
    setDraft((prev) => {
      const next: Draft = { ...prev };
      for (const [k, v] of Object.entries(p)) {
        (next as Record<string, unknown>)[k] = NUM_KEYS.includes(k as NumKey) ? String(v) : v;
      }
      return next;
    });

  // Debounce the queue name so typing doesn't fire a counts fetch per keystroke
  // (and the card header always matches the queue whose counts are shown).
  const [pollQueue, setPollQueue] = useState(DEFAULT_CONFIG.queue);
  useEffect(() => {
    const t = setTimeout(() => setPollQueue(draft.queue.trim() || DEFAULT_CONFIG.queue), 400);
    return () => clearTimeout(t);
  }, [draft.queue]);

  // Live server-side queue depth — proof the load lands and drains. Errors flow
  // to usePolledData, which keeps the last good counts (card stays mounted).
  const { data: counts, error: countsError } = usePolledData(
    () => bq.counts(pollQueue),
    [pollQueue],
    {
      intervalMs: 1000,
    }
  );
  const c = counts?.counts ?? null;

  const [cleaning, setCleaning] = useState(false);
  const [cleanResult, setCleanResult] = useState<{ remaining: number } | null>(null);
  const cleanup = async () => {
    const q = draft.queue.trim();
    if (cleaning || !q || !window.confirm(`Remove benchmark jobs from "${q}"?`)) return;
    setCleaning(true);
    setCleanResult(null);
    try {
      for (const state of ['waiting', 'completed', 'failed', 'delayed']) {
        try {
          await bq.clean(q, { state, limit: LIMITS.total });
        } catch {
          /* state not cleanable */
        }
      }
      // Pulled-but-unacked jobs can't be cleaned; the server requeues them after
      // its stall timeout — tell the user instead of silently under-cleaning.
      const after = await bq.counts(q).catch(() => null);
      setCleanResult({ remaining: after?.counts?.active ?? 0 });
    } finally {
      setCleaning(false);
    }
  };

  // Progress and result labels derive from the config the RUN was started with,
  // not the still-editable form (editing fields must not rewrite a shown result).
  const shown = bench.runCfg ?? toConfig(draft);
  const shownTotal = clampInt(shown.total, 1, LIMITS.total);
  const shownWorkers = clampInt(shown.workers, 0, LIMITS.workers);
  const producePct =
    shown.mode === 'count' && (active || summary)
      ? Math.min(100, (live.pushed / shownTotal) * 100)
      : 0;
  const drainPct =
    shown.mode === 'count' && (active || summary)
      ? Math.min(100, (live.completed / shownTotal) * 100)
      : 0;
  const durationPct =
    shown.mode === 'duration'
      ? Math.min(
          100,
          (live.elapsedMs / (clampInt(shown.durationS, 1, LIMITS.durationS) * 1000)) * 100
        )
      : 0;

  const heading =
    phase === 'running'
      ? shown.mode === 'duration'
        ? 'Running…'
        : 'Producing…'
      : phase === 'draining'
        ? 'Draining…'
        : phase === 'stopping'
          ? 'Stopping…'
          : phase === 'error'
            ? 'Error'
            : summary
              ? 'Result'
              : 'Ready';

  const etaText =
    (phase === 'running' || phase === 'draining') && live.etaMs != null
      ? live.etaMs > 0
        ? `ETA ${formatMs(live.etaMs)}`
        : 'finishing…'
      : phase === 'stopped'
        ? 'stopped early'
        : phase === 'done'
          ? 'complete'
          : '';

  return (
    <div>
      <PageHeader
        title="Benchmark"
        description="Drive real load against the server — producers bulk-enqueue jobs while simulated workers pull, process and ack them. Throughput is measured client-side; the queue genuinely fills and drains."
        actions={
          phase === 'stopping' ? (
            <Button variant="warning" size="sm" disabled>
              <IconPause className="size-3.5" /> Stopping…
            </Button>
          ) : active ? (
            <Button variant="warning" size="sm" onClick={bench.stop}>
              <IconPause className="size-3.5" /> Stop
            </Button>
          ) : (
            <Button variant="success" size="sm" onClick={() => bench.run(toConfig(draft))}>
              <IconPlay className="size-3.5" /> Run benchmark
            </Button>
          )
        }
      />

      {live.error && (
        <div className="mb-4 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-2 text-sm text-danger">
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
            onClick={() => applyPreset(PRESETS[name])}
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
                value={draft.queue}
                disabled={active}
                onChange={(e) => set('queue', e.target.value)}
              />
            </Field>

            <Field
              label="Mode"
              hint={
                draft.mode === 'count'
                  ? 'Push a fixed number of jobs.'
                  : 'Run producers + workers for a fixed time.'
              }
            >
              <SegmentedControl
                options={MODES}
                value={draft.mode}
                onChange={(m) => set('mode', m)}
                disabled={active}
              />
            </Field>

            {draft.mode === 'count' ? (
              <Field label="Total jobs" hint={`max ${formatNumber(LIMITS.total)}`}>
                <Input
                  type="number"
                  min={1}
                  max={LIMITS.total}
                  value={draft.total}
                  disabled={active}
                  onChange={num('total')}
                />
              </Field>
            ) : (
              <Field label="Duration (s)" hint={`max ${LIMITS.durationS}s`}>
                <Input
                  type="number"
                  min={1}
                  max={LIMITS.durationS}
                  value={draft.durationS}
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
                  min={draft.mode === 'duration' ? 0 : 1}
                  max={LIMITS.producers}
                  value={draft.producers}
                  disabled={active}
                  onChange={num('producers')}
                />
              </Field>
              <Field label="Push batch" hint={`jobs/req, max ${LIMITS.batch}`}>
                <Input
                  type="number"
                  min={1}
                  max={LIMITS.batch}
                  value={draft.batch}
                  disabled={active}
                  onChange={num('batch')}
                />
              </Field>
              <Field label="Payload" hint={`bytes/job, max ${formatNumber(LIMITS.payload)}`}>
                <Input
                  type="number"
                  min={0}
                  max={LIMITS.payload}
                  value={draft.payload}
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
                  min={0}
                  max={LIMITS.workers}
                  value={draft.workers}
                  disabled={active}
                  onChange={num('workers')}
                />
              </Field>
              <Field label="Pull batch" hint={`jobs/pull, max ${LIMITS.workerBatch}`}>
                <Input
                  type="number"
                  min={1}
                  max={LIMITS.workerBatch}
                  value={draft.workerBatch}
                  disabled={active}
                  onChange={num('workerBatch')}
                />
              </Field>
              <Field label="Process (ms)" hint="simulated work per pull">
                <Input
                  type="number"
                  min={0}
                  max={LIMITS.processMs}
                  value={draft.processMs}
                  disabled={active}
                  onChange={num('processMs')}
                />
              </Field>
            </div>

            {/* biome-ignore lint/a11y/noLabelWithoutControl: Toggle renders a native <button role="switch">, a labelable control the rule can't see through the component */}
            <label className="flex cursor-pointer items-center gap-2">
              <Toggle
                checked={draft.durable}
                onChange={(v) => set('durable', v)}
                disabled={active}
              />
              <span className="text-sm text-muted">Durable (fsync each job)</span>
            </label>
            {/* biome-ignore lint/a11y/noLabelWithoutControl: Toggle renders a native <button role="switch">, a labelable control the rule can't see through the component */}
            <label className="flex cursor-pointer items-center gap-2">
              <Toggle
                checked={draft.removeOnComplete}
                onChange={(v) => set('removeOnComplete', v)}
                disabled={active}
              />
              <span className="text-sm text-muted">Remove on complete</span>
            </label>

            <div className="flex items-center gap-3 pt-1">
              <Button variant="ghost" size="sm" disabled={active || cleaning} onClick={cleanup}>
                {cleaning ? 'Cleaning…' : 'Clean queue'}
              </Button>
              {cleanResult && (
                <span
                  className={cn(
                    'text-xs',
                    cleanResult.remaining > 0 ? 'text-warning' : 'text-success'
                  )}
                >
                  {cleanResult.remaining > 0
                    ? `Cleaned — ${formatNumber(cleanResult.remaining)} active job(s) remain (requeued after the stall timeout)`
                    : 'Cleaned — 0 jobs remain'}
                </span>
              )}
            </div>
          </div>
        </Card>

        <div className="flex flex-col gap-6 lg:col-span-2">
          <Card>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-base font-semibold text-fg">{heading}</h3>
              <span className="text-xs text-faint">{etaText}</span>
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
              <StatCard
                label="Completed"
                value={formatNumber(live.completed)}
                tone="green"
                compact
              />
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
            <StatCard label="Duration" value={formatMs(summary.durationMs)} compact />
            <StatCard
              label="Avg push/s"
              value={fmtRate(summary.pushPerSec)}
              tone="accent"
              compact
            />
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
      )}

      <Card className="mt-6">
        <CardHeader
          title={`Server queue: ${pollQueue}`}
          action={
            countsError ? (
              <span className="text-xs font-medium text-warning">stale — server unreachable</span>
            ) : undefined
          }
        />
        <p className="-mt-3 mb-4 text-xs text-faint">Live counts from the server (poll 1s).</p>
        {c ? (
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
        ) : (
          <p className="text-sm text-faint">
            No counts yet — waiting for the server to answer for this queue.
          </p>
        )}
      </Card>

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
