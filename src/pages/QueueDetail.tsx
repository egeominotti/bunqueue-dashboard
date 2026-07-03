import { useCallback, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Button, IconButton } from '@/components/ui/Button';
import { LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { IconArrowRight, IconChevronLeft, IconPause, IconPlay } from '@/components/ui/icons';
import { StatCard } from '@/components/ui/StatCard';
import { StatusBadge, StatusDot } from '@/components/ui/StatusBadge';
import { api } from '@/lib/api';
import {
  errorRate,
  formatDuration,
  formatNumber,
  formatPercent,
  formatRelativeTime,
  jobDuration,
} from '@/lib/format';
import type { Job, QueueDetailResponse } from '@/lib/types';
import { usePolledData } from '@/lib/usePolledData';
import { QueueConfig } from './queue/QueueConfig';

const RECENT_STATES = ['active', 'waiting', 'completed', 'failed', 'delayed', 'paused'];

const EMPTY: { detail: QueueDetailResponse; jobs: Job[] } = {
  detail: {
    ok: false,
    name: '',
    counts: {
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
      prioritized: 0,
      paused: 0,
    },
    paused: false,
    priorityCounts: {},
    dlqPreview: [],
    timestamp: 0,
  },
  jobs: [],
};

export function QueueDetail() {
  const { name = '' } = useParams();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const fetcher = useCallback(async () => {
    const [detail, jobs] = await Promise.all([
      api.queueDetail(name, false),
      api.jobsList(name, { states: RECENT_STATES, limit: 12 }),
    ]);
    return { detail, jobs: jobs.jobs ?? [] };
  }, [name]);
  const { data, error, loading, refetch } = usePolledData(fetcher, [name]);

  const run = async (label: string, fn: () => Promise<unknown>, confirmMsg?: string) => {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    setBusy(label);
    setActionError(null);
    try {
      await fn();
      if (label === 'obliterate') {
        navigate('/queues');
        return;
      }
      await refetch();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (loading && !data && !error) return <LoadingState label={`Loading ${name}…`} />;

  const d = data ?? EMPTY;
  const { detail } = d;
  const c = detail.counts;
  const rate = errorRate(c.completed ?? 0, c.failed ?? 0) ?? 0;
  const recent = [...d.jobs].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));

  return (
    <div>
      {error && <OfflineBanner onRetry={refetch} />}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <IconButton aria-label="Back to queues" onClick={() => navigate('/queues')}>
            <IconChevronLeft className="size-4" />
          </IconButton>
          <div>
            <h1 className="font-mono text-2xl font-bold tracking-tight text-fg">{name}</h1>
            <div className="mt-1.5 flex items-center gap-3">
              <StatusDot
                label={detail.paused ? 'Paused' : 'Active'}
                tone={detail.paused ? 'amber' : 'green'}
              />
              <StatusDot label="Live" tone="green" />
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
          <Button
            size="sm"
            disabled={busy != null}
            onClick={() =>
              run('drain', () => api.drain(name), `Drain all waiting jobs from "${name}"?`)
            }
          >
            Drain
          </Button>
          <Button
            variant="danger"
            size="sm"
            disabled={busy != null}
            onClick={() =>
              run(
                'obliterate',
                () => api.obliterate(name),
                `Obliterate "${name}"? This removes the queue and all its jobs.`
              )
            }
          >
            Obliterate
          </Button>
        </div>
      </div>

      {actionError && (
        <div className="mb-4 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-2 text-sm text-red-400">
          {actionError}
        </div>
      )}

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
          value={formatPercent(rate)}
          tone={rate > 0.05 ? 'red' : 'green'}
        />
      </div>

      <div className="mt-8">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-fg">Recent Jobs</h2>
          <Link
            to={`/jobs?queue=${encodeURIComponent(name)}`}
            className="flex items-center gap-1 text-sm text-muted hover:text-fg"
          >
            View all jobs <IconArrowRight className="size-3.5" />
          </Link>
        </div>
        <div className="overflow-hidden rounded-xl border border-line bg-surface">
          <table className="w-full text-sm">
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
              {recent.length === 0 ? (
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
                    <td className="px-5 py-3 font-mono text-xs text-muted">{j.id}</td>
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
