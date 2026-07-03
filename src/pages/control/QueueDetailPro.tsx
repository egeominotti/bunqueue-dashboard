import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toast } from '@/components/dashboard/stores/toastStore';
import { AreaChart } from '@/components/ui/AreaChart';
import { Button, IconButton } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { IconArrowRight, IconChevronLeft } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatCard } from '@/components/ui/StatCard';
import { StatusDot } from '@/components/ui/StatusBadge';
import { bq } from '@/lib/bq';
import type { JobFull } from '@/lib/bqTypes';
import { cn } from '@/lib/cn';
import { errorRate, formatDuration, formatNumber, formatPercent } from '@/lib/format';
import { usePolledData } from '@/lib/usePolledData';
import { depthTrend } from '@/lib/useThroughputSeries';
import { DlqConfigForm, StallForm } from './queue/ConfigForms';
import { LifecycleCard, LimitsCards } from './queue/QueueActions';

const COUNT_KEYS = ['waiting', 'active', 'completed', 'failed', 'delayed', 'paused'] as const;
const RECENT_STATES = ['active', 'waiting', 'completed', 'failed', 'delayed'];
const MAX_DEPTH_POINTS = 40;
const DEPTH_SAMPLE_MS = 2000;

/**
 * Pro per-queue operations page, reached by drilling into a queue from the Overview
 * or Queues list (`/queues/:name`). Route-param driven (deep-linkable), unlike the
 * dropdown-based Queue Control page. Reuses the same lifecycle/limits/config
 * building blocks as QueueControl, adds obliterate, a live backlog-depth sparkline,
 * recent jobs, and jump-off links to this queue's Jobs and DLQ views.
 */
export function QueueDetailPro() {
  const { name = '' } = useParams();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const fetcher = useCallback(async () => {
    if (!name) return null;
    const [detail, stall, dlq, jobs] = await Promise.all([
      bq.queueDetail(name, false),
      bq.getStallConfig(name).catch(() => null),
      bq.getDlqConfig(name).catch(() => null),
      bq.jobsList(name, RECENT_STATES, 12).catch(() => ({ ok: false, jobs: [] as JobFull[] })),
    ]);
    // Tag with the queue it was fetched for, so a param change can't render (or
    // save) queue A's data under queue B for one round-trip (QueueControl pattern).
    return {
      queue: name,
      detail,
      stall: stall?.config ?? null,
      dlq: dlq?.config ?? null,
      jobs: jobs.jobs ?? [],
    };
  }, [name]);
  const { data: raw, error, loading, refetch } = usePolledData(fetcher, [name]);
  const data = raw && raw.queue === name ? raw : null;

  // Rolling backlog-depth series, sampled on a fixed timer (no per-queue history
  // endpoint exists). A timer — rather than accumulating on payload change — means
  // an idle queue whose counts never move still produces a flat line instead of
  // sitting on "Sampling…" forever. Reset when the queue changes.
  const [depth, setDepth] = useState<number[]>([]);
  const depthRef = useRef<number | null>(null);
  useEffect(() => {
    const c = data?.detail?.counts;
    if (c) depthRef.current = (c.waiting ?? 0) + (c.active ?? 0) + (c.delayed ?? 0);
  }, [data]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-arm the sampler (and clear the series) only when the queue changes
  useEffect(() => {
    depthRef.current = null;
    setDepth([]);
    const id = setInterval(() => {
      const d = depthRef.current;
      if (d != null) setDepth((s) => [...s, d].slice(-MAX_DEPTH_POINTS));
    }, DEPTH_SAMPLE_MS);
    return () => clearInterval(id);
  }, [name]);

  const run = (label: string, fn: () => Promise<unknown>, confirmMsg?: string) => {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    setBusy(true);
    setMsg(null);
    fn()
      .then((r) => {
        const count = (r as { count?: number })?.count;
        const text = `${label}${count != null ? `: ${count}` : ' ✓'}`;
        setMsg({ ok: true, text });
        toast.success(text, name);
        refetch();
      })
      .catch((e: unknown) => {
        const text = (e as Error).message;
        setMsg({ ok: false, text });
        toast.error(`${label} failed`, text);
      })
      .finally(() => setBusy(false));
  };

  const obliterate = () => {
    if (!window.confirm(`Obliterate "${name}"? This removes the queue and all its jobs.`)) return;
    setBusy(true);
    bq.obliterate(name)
      .then(() => {
        toast.success('Queue obliterated', name);
        navigate('/queues');
      })
      .catch((e: unknown) => {
        const text = (e as Error).message;
        setMsg({ ok: false, text });
        toast.error('Obliterate failed', text);
        setBusy(false);
      });
  };

  const detail = data?.detail;
  const c = detail?.counts;
  const rate = c ? (errorRate(c.completed ?? 0, c.failed ?? 0) ?? 0) : 0;
  const trend = depthTrend(depth);

  return (
    <div>
      <PageHeader
        title={<span className="font-mono">{name}</span>}
        description="Full per-queue operations and live backlog."
        live
        back={
          <IconButton aria-label="Back to queues" onClick={() => navigate('/queues')}>
            <IconChevronLeft className="size-4" />
          </IconButton>
        }
        actions={
          <>
            <Link
              to={`/jobs?queue=${encodeURIComponent(name)}`}
              className="flex items-center gap-1 rounded-lg border border-line px-3 py-1.5 text-sm text-muted hover:bg-surface-2 hover:text-fg"
            >
              Jobs <IconArrowRight className="size-3.5" />
            </Link>
            <Link
              to="/dlq"
              className="flex items-center gap-1 rounded-lg border border-line px-3 py-1.5 text-sm text-muted hover:bg-surface-2 hover:text-fg"
            >
              DLQ <IconArrowRight className="size-3.5" />
            </Link>
            <Button variant="danger" size="sm" disabled={busy} onClick={obliterate}>
              Obliterate
            </Button>
          </>
        }
      />

      {error && <OfflineBanner onRetry={refetch} />}

      {loading && !data && !error ? (
        <LoadingState label={`Loading ${name}…`} />
      ) : !detail || !c ? (
        !error && <p className="text-sm text-faint">Queue not found.</p>
      ) : (
        <>
          <div className="mb-6 flex flex-wrap items-center gap-3">
            <StatusDot
              label={detail.paused ? 'Paused' : 'Active'}
              tone={detail.paused ? 'amber' : 'green'}
            />
            {msg && (
              <span className={msg.ok ? 'text-xs text-success' : 'text-xs text-danger'}>
                {msg.text}
              </span>
            )}
          </div>

          <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            {COUNT_KEYS.map((k) => (
              <StatCard
                key={k}
                label={k}
                value={formatNumber(c[k])}
                tone={k === 'failed' && c.failed ? 'red' : 'default'}
                compact
              />
            ))}
          </div>

          <Card className="mb-6">
            <CardHeader
              title="Backlog depth"
              action={
                <span
                  className={cn(
                    'rounded-full px-2 py-0.5 text-[11px] font-medium',
                    trend.draining
                      ? 'bg-emerald-500/10 text-success'
                      : trend.label === 'accumulating'
                        ? 'bg-red-500/10 text-danger'
                        : 'bg-surface-2 text-muted'
                  )}
                >
                  {trend.label}
                </span>
              }
            />
            {depth.length < 2 ? (
              <p className="py-6 text-center text-xs text-faint">
                Sampling… the backlog trend appears after a few polls.
              </p>
            ) : (
              <AreaChart
                height={140}
                ariaLabel={`${name} backlog depth`}
                series={[{ label: 'depth', color: 'var(--accent)', points: depth, area: true }]}
              />
            )}
            <div className="mt-1 flex items-center justify-between text-xs text-faint">
              <span>waiting + active + delayed</span>
              <span className="tnum">Error rate {formatPercent(rate)}</span>
            </div>
          </Card>

          <LifecycleCard queue={name} paused={detail.paused} busy={busy} run={run} />
          <LimitsCards queue={name} busy={busy} run={run} />

          <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
            {data.stall && (
              <StallForm
                key={name}
                queue={name}
                config={data.stall}
                onSaved={() => {
                  setMsg({ ok: true, text: 'Stall config saved ✓' });
                  toast.success('Stall config saved', name);
                }}
              />
            )}
            {data.dlq && (
              <DlqConfigForm
                key={name}
                queue={name}
                config={data.dlq}
                onSaved={() => {
                  setMsg({ ok: true, text: 'DLQ config saved ✓' });
                  toast.success('DLQ config saved', name);
                }}
              />
            )}
          </div>

          <Card padded={false}>
            <div className="flex items-center justify-between px-5 py-3">
              <h2 className="text-base font-semibold text-fg">Recent jobs</h2>
              <Link
                to={`/jobs?queue=${encodeURIComponent(name)}`}
                className="flex items-center gap-1 text-sm text-muted hover:text-fg"
              >
                View all <IconArrowRight className="size-3.5" />
              </Link>
            </div>
            <div className="overflow-x-auto border-t border-line">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-faint">
                    <th className="px-5 py-3 font-medium">ID</th>
                    <th className="px-5 py-3 font-medium">State</th>
                    <th className="px-5 py-3 text-right font-medium">Attempts</th>
                    <th className="px-5 py-3 text-right font-medium">Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {data.jobs.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-5 py-10 text-center text-sm text-faint">
                        No recent jobs.
                      </td>
                    </tr>
                  ) : (
                    data.jobs.map((j) => (
                      <tr
                        key={j.id}
                        className="border-b border-line last:border-0 hover:bg-surface-2/40"
                      >
                        <td className="px-5 py-3">
                          <Link
                            to={`/job?id=${encodeURIComponent(j.id)}`}
                            className="font-mono text-xs text-accent hover:underline"
                          >
                            {j.id}
                          </Link>
                        </td>
                        <td className="px-5 py-3 text-muted">{j.state ?? '—'}</td>
                        <td className="px-5 py-3 text-right tnum text-muted">
                          {j.attempts ?? 0} / {j.maxAttempts ?? '?'}
                        </td>
                        <td className="px-5 py-3 text-right tnum text-muted">
                          {formatDuration(
                            j.startedAt && j.completedAt ? j.completedAt - j.startedAt : undefined
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
