import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { toast } from '@/components/dashboard/stores/toastStore';
import { AreaChart } from '@/components/ui/AreaChart';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { EmptyState, ErrorState, LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { IconArrowRight, IconChevronLeft } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatCard } from '@/components/ui/StatCard';
import { StatusDot } from '@/components/ui/StatusBadge';
import { bq } from '@/lib/bq';
import type { JobFull } from '@/lib/bqTypes';
import { cn } from '@/lib/cn';
import { FLOW_DELETION_UNAVAILABLE } from '@/lib/flowMutationSafety';
import { errorRate, formatDuration, formatNumber, formatPercent } from '@/lib/format';
import { usePolledData } from '@/lib/usePolledData';
import { assertSuccessfulMutationResponse, useServerActionGuard } from '@/lib/useServerActionGuard';
import { depthTrend } from '@/lib/useThroughputSeries';
import { ConfigLoadError, DlqConfigForm, StallForm } from './queue/ConfigForms';
import { LifecycleCard, LimitsCards } from './queue/QueueActions';

const COUNT_KEYS = [
  'waiting',
  'prioritized',
  'active',
  'waiting-children',
  'delayed',
  'completed',
  'failed',
  'paused',
] as const;
const RECENT_STATES = [
  'active',
  'waiting',
  'prioritized',
  'waiting-children',
  'completed',
  'failed',
  'delayed',
];
const MAX_DEPTH_POINTS = 40;
const DEPTH_SAMPLE_MS = 2000;

/**
 * Pro per-queue operations page, reached by drilling into a queue from the Overview
 * or Queues list (`/queues/:name`). Route-param driven (deep-linkable), unlike the
 * dropdown-based Queue Control page. Reuses the same lifecycle/limits/config
 * building blocks as QueueControl, shows the unavailable obliterate capability, a live backlog-depth sparkline,
 * recent jobs, and jump-off links to this queue's Jobs and DLQ views.
 */
export function QueueDetailPro() {
  const { name = '' } = useParams();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const actionGuard = useServerActionGuard(`queue:${name}`);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scopeKey is the queue+connection lifecycle boundary
  useEffect(() => {
    setBusy(false);
    setMsg(null);
  }, [actionGuard.scopeKey]);

  const fetcher = useCallback(async () => {
    if (!name) return null;
    // v2.8.55 synthesizes an empty detail for any valid queue name. Establish
    // membership first so a typo never exposes destructive controls for a
    // queue that does not actually exist.
    const summary = await bq.queuesSummary();
    if (!summary.some((queue) => queue.name === name)) {
      return {
        queue: name,
        exists: false as const,
        detail: null,
        stall: null,
        dlq: null,
        jobs: [] as JobFull[],
        recentJobsError: null as string | null,
      };
    }
    const [detail, stall, dlq, recentJobs] = await Promise.all([
      bq.queueDetail(name, false),
      bq.getStallConfig(name).catch(() => null),
      bq.getDlqConfig(name).catch(() => null),
      bq
        .jobsList(name, RECENT_STATES, 12)
        .then((result) => ({ jobs: result.jobs ?? [], error: null as string | null }))
        .catch((error: unknown) => ({
          jobs: [] as JobFull[],
          error: (error as Error).message || 'Unknown error',
        })),
    ]);
    // Tag with the queue it was fetched for, so a param change can't render (or
    // save) queue A's data under queue B for one round-trip (QueueControl pattern).
    return {
      queue: name,
      exists: true as const,
      detail,
      stall: stall?.config ?? null,
      dlq: dlq?.config ?? null,
      jobs: recentJobs.jobs,
      recentJobsError: recentJobs.error,
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
    if (c) {
      depthRef.current =
        (c.waiting ?? 0) +
        (c.prioritized ?? 0) +
        (c.active ?? 0) +
        (c.delayed ?? 0) +
        (c['waiting-children'] ?? 0);
    }
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

  const run = async (
    label: string,
    fn: () => Promise<unknown>,
    confirmMsg?: string,
    onSuccess?: () => void
  ) => {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    const lease = actionGuard.begin();
    if (!lease) return;
    setBusy(true);
    setMsg(null);
    try {
      const summary = await bq.queuesSummary();
      if (!lease.isCurrent()) return;
      if (!summary.some((candidate) => candidate.name === name)) {
        throw new Error(`Queue "${name}" no longer exists`);
      }
      const response = await fn();
      assertSuccessfulMutationResponse(response, label);
      if (!lease.isCurrent()) return;
      const count = response.count;
      if (count !== undefined && (!Number.isSafeInteger(count) || (count as number) < 0)) {
        throw new Error(`${label} returned an invalid count`);
      }
      const text = `${label}${count != null ? `: ${count}` : ' ✓'}`;
      setMsg({ ok: true, text });
      toast.success(text, name);
      onSuccess?.();
      refetch();
    } catch (e) {
      if (!lease.isCurrent()) return;
      const text = (e as Error).message;
      setMsg({ ok: false, text });
      toast.error(`${label} failed`, text);
    } finally {
      if (lease.finish()) setBusy(false);
    }
  };

  const detail = data?.detail;
  const c = detail?.counts;
  // Keep null when nothing has been processed — "0.00%" from zero data is a
  // claim, not a measurement (errorRate's contract; OverviewPro follows it too).
  const rate = c ? errorRate(c.completed ?? 0, c.failed ?? 0) : null;
  const trend = depthTrend(depth);

  return (
    <div>
      <PageHeader
        title={<span className="font-mono">{name}</span>}
        description="Full per-queue operations and complete live non-terminal depth."
        live={
          data?.exists === true &&
          !!data.detail &&
          !!data.stall &&
          !!data.dlq &&
          !data.recentJobsError &&
          !error
        }
        back={
          <Link
            to="/queues"
            aria-label="Back to queues"
            className="inline-flex size-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
          >
            <IconChevronLeft className="size-4" />
          </Link>
        }
        actions={
          data?.exists === true ? (
            <>
              <Link
                to={`/jobs?queue=${encodeURIComponent(name)}`}
                className="flex items-center gap-1 rounded-lg border border-line px-3 py-1.5 text-sm text-muted hover:bg-surface-2 hover:text-fg"
              >
                Jobs <IconArrowRight className="size-3.5" />
              </Link>
              <Link
                to={`/dlq?queue=${encodeURIComponent(name)}`}
                className="flex items-center gap-1 rounded-lg border border-line px-3 py-1.5 text-sm text-muted hover:bg-surface-2 hover:text-fg"
              >
                DLQ <IconArrowRight className="size-3.5" />
              </Link>
              <Button variant="danger" size="sm" disabled title={FLOW_DELETION_UNAVAILABLE}>
                Obliterate
              </Button>
            </>
          ) : undefined
        }
      />

      {error && data && (
        <OfflineBanner
          message="Queue refresh failed — showing the last successful snapshot."
          onRetry={refetch}
        />
      )}

      {error && !data ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : loading && !data ? (
        <LoadingState label={`Loading ${name}…`} />
      ) : data?.exists === false || !detail || !c ? (
        !error && (
          <EmptyState
            title="Queue not found"
            hint={`No queue named "${name}" exists — it may have been obliterated, or the link is stale.`}
            action={
              <Link
                to="/queues"
                className="rounded-lg border border-line px-3 py-1.5 text-sm text-muted hover:bg-surface-2 hover:text-fg"
              >
                Back to queues
              </Link>
            }
          />
        )
      ) : (
        <>
          <div className="mb-6 flex flex-wrap items-center gap-3">
            <StatusDot
              label={detail.paused ? 'Paused' : 'Active'}
              tone={detail.paused ? 'amber' : 'green'}
            />
            {msg && (
              <span
                role="status"
                className={msg.ok ? 'text-xs text-success' : 'text-xs text-danger'}
              >
                {msg.text}
              </span>
            )}
            <span className="text-xs text-warning">{FLOW_DELETION_UNAVAILABLE}</span>
          </div>

          <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
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

          <Card padded={false} className="mb-6">
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
                    <th scope="col" className="px-5 py-3 font-medium">
                      ID
                    </th>
                    <th scope="col" className="px-5 py-3 font-medium">
                      Name
                    </th>
                    <th scope="col" className="px-5 py-3 font-medium">
                      State
                    </th>
                    <th scope="col" className="px-5 py-3 text-right font-medium">
                      Attempts
                    </th>
                    <th scope="col" className="px-5 py-3 text-right font-medium">
                      Duration
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.recentJobsError ? (
                    <tr>
                      <td colSpan={5} className="px-5 py-10 text-center text-sm text-danger">
                        Could not load recent jobs — {data.recentJobsError}. Retry the page.
                      </td>
                    </tr>
                  ) : data.jobs.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-5 py-10 text-center text-sm text-faint">
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
                        <td className="px-5 py-3 font-mono text-xs text-muted">
                          {j.name ?? 'default'}
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

          <PriorityHistogram counts={detail.priorityCounts} />

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
              <span>waiting + prioritized + active + delayed + waiting-children</span>
              <span className="tnum">Error rate {rate == null ? '—' : formatPercent(rate)}</span>
            </div>
          </Card>

          <LifecycleCard queue={name} paused={detail.paused} busy={busy} run={run} />
          <LimitsCards key={`${name}:limits`} queue={name} busy={busy} run={run} />

          <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
            {data.stall ? (
              <StallForm
                key={`${name}:stall`}
                queue={name}
                config={data.stall}
                onSaved={() => {
                  setMsg({ ok: true, text: 'Stall config saved ✓' });
                  toast.success('Stall config saved', name);
                }}
              />
            ) : (
              <ConfigLoadError title="Stall detection" onRetry={refetch} />
            )}
            {data.dlq ? (
              <DlqConfigForm
                key={`${name}:dlq`}
                queue={name}
                config={data.dlq}
                onSaved={() => {
                  setMsg({ ok: true, text: 'DLQ config saved ✓' });
                  toast.success('DLQ config saved', name);
                }}
              />
            ) : (
              <ConfigLoadError title="DLQ policy" onRetry={refetch} />
            )}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Per-priority backlog distribution. The server already ships `priorityCounts`
 * inside the queue-detail payload (priority level → number of waiting jobs); it
 * was fetched and dropped before. A histogram is the most direct read on whether
 * high-priority jobs are starving low-priority ones. Hidden when empty.
 */
function PriorityHistogram({ counts }: { counts: Record<string, number> }) {
  const rows = Object.entries(counts ?? {})
    .map(([p, n]) => [Number(p), n] as const)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[0] - a[0]);
  if (rows.length === 0) return null;
  const max = Math.max(...rows.map(([, n]) => n));
  return (
    <Card className="mb-6">
      <CardHeader title="Jobs by priority" />
      <div className="flex flex-col gap-2">
        {rows.map(([p, n]) => (
          <div key={p} className="flex items-center gap-3">
            <span className="w-16 shrink-0 text-right font-mono text-xs text-muted">p{p}</span>
            <div className="h-4 flex-1 overflow-hidden rounded bg-surface-2">
              <div
                className="h-full rounded bg-accent"
                style={{ width: `${Math.max(2, (n / max) * 100)}%` }}
              />
            </div>
            <span className="w-14 shrink-0 tnum text-xs text-fg">{formatNumber(n)}</span>
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-faint">Higher p = higher priority. Waiting jobs only.</p>
    </Card>
  );
}
