import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { EmptyState, LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { IconArrowRight, IconChevronLeft, IconPause, IconPlay } from '@/components/ui/icons';
import { StatCard } from '@/components/ui/StatCard';
import { StatusBadge, StatusDot } from '@/components/ui/StatusBadge';
import { api } from '@/lib/api';
import { bq } from '@/lib/bq';
import { FLOW_DELETION_UNAVAILABLE } from '@/lib/flowMutationSafety';
import {
  errorRate,
  formatDuration,
  formatNumber,
  formatPercent,
  formatRelativeTime,
  jobDuration,
} from '@/lib/format';
import type { Job } from '@/lib/types';
import { usePolledData } from '@/lib/usePolledData';
import { assertSuccessfulMutationResponse, useServerActionGuard } from '@/lib/useServerActionGuard';
import { QueueConfig } from './queue/QueueConfig';
import { EMPTY_QUEUE_DETAIL, RECENT_STATES } from './queue/queueDetailData';

export function QueueDetail() {
  const { name = '' } = useParams();
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const actionGuard = useServerActionGuard(`classic-queue:${name}`);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scopeKey is the route+connection lifecycle boundary
  useEffect(() => {
    setBusy(null);
    setActionError(null);
  }, [actionGuard.scopeKey]);

  const fetcher = useCallback(async () => {
    const summary = await bq.queuesSummary();
    if (!summary.some((queue) => queue.name === name)) {
      return {
        exists: false as const,
        detail: null,
        jobs: [] as Job[],
        recentJobsError: null as string | null,
      };
    }
    const [detail, recentJobs] = await Promise.all([
      api.queueDetail(name, false),
      api
        .jobsList(name, { states: RECENT_STATES, limit: 12 })
        .then((result) => ({ jobs: result.jobs ?? [], error: null as string | null }))
        .catch((recentError: unknown) => ({
          jobs: [] as Job[],
          error: (recentError as Error).message || 'Unknown error',
        })),
    ]);
    if (detail.ok !== true || detail.name !== name) {
      throw new Error(`Malformed queue detail response for "${name}"`);
    }
    return {
      exists: true as const,
      detail,
      jobs: recentJobs.jobs,
      recentJobsError: recentJobs.error,
    };
  }, [name]);
  const { data, error, loading, refetch } = usePolledData(fetcher, [name]);

  const run = async (label: string, fn: () => Promise<unknown>, confirmMsg?: string) => {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    const lease = actionGuard.begin(label);
    if (!lease) return;
    setBusy(label);
    setActionError(null);
    try {
      const queues = await bq.queuesSummary();
      if (!lease.isCurrent()) return;
      if (!queues.some((queue) => queue.name === name)) {
        throw new Error(`Queue "${name}" no longer exists`);
      }
      const response = await fn();
      assertSuccessfulMutationResponse(response, label);
      if (!lease.isCurrent()) return;
      await refetch();
    } catch (e) {
      if (lease.isCurrent()) setActionError((e as Error).message);
    } finally {
      if (lease.finish()) setBusy(null);
    }
  };

  if (loading && !data && !error) return <LoadingState label={`Loading ${name}…`} />;
  if (error && !data) {
    return (
      <div>
        <h1 className="mb-4 font-mono text-2xl font-bold tracking-tight text-fg">{name}</h1>
        <OfflineBanner onRetry={refetch} />
      </div>
    );
  }

  if (data?.exists === false) {
    return (
      <div>
        {error && <OfflineBanner onRetry={refetch} />}
        <h1 className="mb-4 font-mono text-2xl font-bold tracking-tight text-fg">{name}</h1>
        <EmptyState
          title="Queue not found"
          hint={`No queue named "${name}" exists on the current Bunqueue server.`}
          action={
            <Link
              to="/queues-classic"
              className="rounded-lg border border-line px-3 py-1.5 text-sm text-muted hover:bg-surface-2 hover:text-fg"
            >
              Back to classic queues
            </Link>
          }
        />
      </div>
    );
  }

  const d = data?.exists === true ? data : EMPTY_QUEUE_DETAIL;
  const { detail } = d;
  const c = detail.counts;
  const rate = errorRate(c.completed ?? 0, c.failed ?? 0);
  const recent = [...d.jobs].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));

  return (
    <div>
      {error && <OfflineBanner onRetry={refetch} />}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <Link
            to="/queues-classic"
            aria-label="Back to classic queues"
            className="inline-flex size-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
          >
            <IconChevronLeft className="size-4" />
          </Link>
          <div>
            <h1 className="font-mono text-2xl font-bold tracking-tight text-fg">{name}</h1>
            <div className="mt-1.5 flex items-center gap-3">
              <StatusDot
                label={detail.paused ? 'Paused' : 'Active'}
                tone={detail.paused ? 'amber' : 'green'}
              />
              <StatusDot label={error ? 'Stale' : 'Live'} tone={error ? 'amber' : 'green'} />
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {detail.paused ? (
            <Button
              variant="success"
              size="sm"
              disabled={busy != null}
              onClick={() => run('resume', () => api.resume(name))}
            >
              <IconPlay className="size-3.5" /> Resume
            </Button>
          ) : (
            <Button
              variant="warning"
              size="sm"
              disabled={busy != null}
              onClick={() => run('pause', () => api.pause(name))}
            >
              <IconPause className="size-3.5" /> Pause
            </Button>
          )}
          <Button size="sm" disabled title={FLOW_DELETION_UNAVAILABLE}>
            Drain
          </Button>
          <Button variant="danger" size="sm" disabled title={FLOW_DELETION_UNAVAILABLE}>
            Obliterate
          </Button>
        </div>
      </div>

      {actionError && (
        <div className="mb-4 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-2 text-sm text-red-400">
          {actionError}
        </div>
      )}
      <p className="mb-4 text-xs text-warning">{FLOW_DELETION_UNAVAILABLE}</p>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Waiting" value={formatNumber(c.waiting)} tone="amber" />
        <StatCard label="Active" value={formatNumber(c.active)} tone="blue" />
        <StatCard label="Completed" value={formatNumber(c.completed)} tone="green" />
        <StatCard
          label="Failed"
          value={formatNumber(c.failed)}
          tone={c.failed ? 'red' : 'default'}
        />
        <StatCard label="Delayed" value={formatNumber(c.delayed)} tone="default" />
        <StatCard
          label="Error Rate"
          value={rate == null ? '—' : formatPercent(rate)}
          tone={rate == null ? 'default' : rate > 0.05 ? 'red' : 'green'}
        />
      </div>

      <div className="mt-8">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-fg">Recent Jobs</h2>
          <Link
            to={`/jobs-classic?queue=${encodeURIComponent(name)}`}
            className="flex items-center gap-1 text-sm text-muted hover:text-fg"
          >
            View all jobs <IconArrowRight className="size-3.5" />
          </Link>
        </div>
        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full min-w-[44rem] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-faint">
                <th className="px-5 py-3 font-medium">ID</th>
                <th className="px-5 py-3 font-medium">Name</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 text-right font-medium">Duration</th>
                <th className="px-5 py-3 text-right font-medium">Created</th>
              </tr>
            </thead>
            <tbody>
              {d.recentJobsError ? (
                <tr>
                  <td colSpan={5} className="px-5 py-12 text-center text-sm text-danger">
                    Could not load recent jobs — {d.recentJobsError}. Retry the page.
                  </td>
                </tr>
              ) : recent.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-5 py-12 text-center text-sm text-faint">
                    No recent jobs.
                  </td>
                </tr>
              ) : (
                recent.map((j: Job) => (
                  <tr
                    key={j.id}
                    className="border-b border-line last:border-0 hover:bg-surface-2/40"
                  >
                    <td className="px-5 py-3 font-mono text-xs">
                      <Link
                        to={`/job?id=${encodeURIComponent(j.id)}`}
                        className="rounded text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                      >
                        {j.id}
                      </Link>
                    </td>
                    <td className="px-5 py-3 text-fg">
                      {(j.data as { name?: string })?.name || 'unknown'}
                    </td>
                    <td className="px-5 py-3">
                      <StatusBadge status={String(j.state ?? j.status ?? 'waiting')} />
                    </td>
                    <td className="px-5 py-3 text-right tnum text-muted">
                      {formatDuration(jobDuration(j.startedAt as number, j.completedAt as number))}
                    </td>
                    <td className="px-5 py-3 text-right text-faint">
                      {formatRelativeTime(j.createdAt)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <QueueConfig queue={name} />
    </div>
  );
}
