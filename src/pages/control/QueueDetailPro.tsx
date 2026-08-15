import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { toast } from '@/components/dashboard/stores/toastStore';
import { Button } from '@/components/ui/Button';
import { EmptyState, ErrorState, LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { IconArrowRight, IconChevronLeft } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatCard } from '@/components/ui/StatCard';
import { StatusDot } from '@/components/ui/StatusBadge';
import { bq } from '@/lib/bq';
import type { JobFull } from '@/lib/bqTypes';
import { FLOW_DELETION_UNAVAILABLE } from '@/lib/flowMutationSafety';
import { errorRate, formatNumber } from '@/lib/format';
import { usePolledData } from '@/lib/usePolledData';
import { assertSuccessfulMutationResponse, useServerActionGuard } from '@/lib/useServerActionGuard';
import { ConfigLoadError, DlqConfigForm, StallForm } from './queue/ConfigForms';
import { LifecycleCard, LimitsCards } from './queue/QueueActions';
import { QUEUE_DETAIL_COUNT_KEYS, QUEUE_DETAIL_RECENT_STATES } from './queueDetail/model';
import {
  BacklogDepthCard,
  PriorityHistogram,
  RecentQueueJobs,
} from './queueDetail/QueueDetailSections';
import { useQueueDepth } from './queueDetail/useQueueDepth';

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
    // v2.8.59 synthesizes an empty detail for any valid queue name. Establish
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
        .jobsList(name, QUEUE_DETAIL_RECENT_STATES, 12)
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

  const { depth, trend } = useQueueDepth(name, data?.detail?.counts);

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
            {QUEUE_DETAIL_COUNT_KEYS.map((k) => (
              <StatCard
                key={k}
                label={k}
                value={formatNumber(c[k])}
                tone={k === 'failed' && c.failed ? 'red' : 'default'}
                compact
              />
            ))}
          </div>

          <RecentQueueJobs name={name} jobs={data.jobs} error={data.recentJobsError} />
          <PriorityHistogram counts={detail.priorityCounts} />
          <BacklogDepthCard name={name} depth={depth} trend={trend} rate={rate} />

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
