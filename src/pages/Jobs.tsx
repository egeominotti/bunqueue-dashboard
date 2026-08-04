import { useCallback, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { SegmentedControl, Select } from '@/components/ui/form';
import { IconSearch } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatCard } from '@/components/ui/StatCard';
import { StatusBadge } from '@/components/ui/StatusBadge';
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
import { settledPool } from '@/lib/promisePool';
import type { Job, QueuesResponse } from '@/lib/types';
import { usePolledData } from '@/lib/usePolledData';

const ALL = '__all__';
const STATUS = ['all', 'waiting', 'active', 'completed', 'failed'] as const;
type StatusFilter = (typeof STATUS)[number];
const QUEUE_PAGE_SIZE = 500;
const JOBS_PER_QUEUE = 40;
const JOB_FANOUT = 8;
const DISPLAY_LIMIT = 100;
/**
 * Bunqueue v2.8.55 has no cross-queue job-list endpoint. Refuse an unbounded
 * "All Queues" refresh instead of turning 10k discovered queues into 10k HTTP
 * requests every 15 seconds merely to render 100 rows.
 */
export const MAX_ALL_QUEUE_JOB_FANOUT = 100;
const MAX_QUEUE_PAGES = 20;
const MAX_DISCOVERED_QUEUES = QUEUE_PAGE_SIZE * MAX_QUEUE_PAGES;

type JobsLoad = {
  scopeKey: string;
  jobs: Job[];
  failures: { queue: string; message: string }[];
  queueCount: number;
  blockedReason: string | null;
};

function validateQueuePage(
  page: QueuesResponse,
  requestedOffset: number,
  expectedTotal: number | null
): void {
  if (
    page == null ||
    typeof page !== 'object' ||
    page.ok !== true ||
    !Array.isArray(page.queues) ||
    !Number.isSafeInteger(page.total) ||
    page.total < 0 ||
    page.total > MAX_DISCOVERED_QUEUES ||
    (expectedTotal !== null && page.total !== expectedTotal) ||
    page.offset !== requestedOffset ||
    page.limit !== QUEUE_PAGE_SIZE ||
    page.queues.length !== Math.min(QUEUE_PAGE_SIZE, page.total - requestedOffset) ||
    page.queues.length > QUEUE_PAGE_SIZE ||
    page.queues.some(
      (row) =>
        row == null ||
        typeof row !== 'object' ||
        typeof row.name !== 'string' ||
        row.name.length === 0 ||
        row.name.length > 256 ||
        !/^[a-zA-Z0-9_\-.:]+$/.test(row.name)
    )
  ) {
    throw new Error('Queue discovery returned a malformed or unsafe page');
  }
}

export async function discoverAllQueues(): Promise<QueuesResponse> {
  const first = await api.queues(QUEUE_PAGE_SIZE, 0);
  validateQueuePage(first, 0, null);
  const queues = [...first.queues];
  const names = new Set<string>();
  for (const row of queues) {
    if (names.has(row.name))
      throw new Error(`Queue discovery returned duplicate queue ${row.name}`);
    names.add(row.name);
  }
  const total = first.total;
  let pageCount = 1;
  while (queues.length < total) {
    if (pageCount >= MAX_QUEUE_PAGES || queues.length >= MAX_DISCOVERED_QUEUES) {
      throw new Error(`Queue discovery exceeds the safety limit of ${MAX_DISCOVERED_QUEUES}`);
    }
    const offset = queues.length;
    const page = await api.queues(QUEUE_PAGE_SIZE, offset);
    validateQueuePage(page, offset, total);
    for (const row of page.queues) {
      if (names.has(row.name)) {
        throw new Error(`Queue discovery pages overlap at queue ${row.name}`);
      }
      names.add(row.name);
      queues.push(row);
    }
    pageCount += 1;
  }
  return { ...first, queues, total, limit: queues.length, offset: 0 };
}

export function jobDataName(data: unknown): string | null {
  if (data == null || typeof data !== 'object' || Array.isArray(data)) return null;
  const name = (data as Record<string, unknown>).name;
  return typeof name === 'string' && name.length > 0 ? name : null;
}

export function Jobs() {
  const [params] = useSearchParams();
  const [queue, setQueue] = useState(params.get('queue') ?? ALL);
  const [status, setStatus] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');

  const {
    data: qs,
    error: queuesError,
    refetch: refetchQueues,
  } = usePolledData(discoverAllQueues, [], { intervalMs: 30000 });
  const {
    data: overview,
    error: overviewError,
    refetch: refetchOverview,
  } = usePolledData(() => api.overview(), []);
  const queueNames = useMemo(() => (qs?.queues ?? []).map((q) => q.name), [qs]);
  const queueNamesKey = JSON.stringify(queueNames);
  const scopeKey = `${queue}\u0000${status}\u0000${queueNamesKey}`;

  const fetcher = useCallback(
    async (signal: AbortSignal): Promise<JobsLoad | null> => {
      // Do not publish a fake empty result while all-queue discovery is pending.
      // `scopeKey` changes when discovery lands, which immediately re-runs this load.
      if (queue === ALL && !qs) return null;
      const names = queue === ALL ? queueNames : [queue];
      if (queue === ALL && names.length > MAX_ALL_QUEUE_JOB_FANOUT) {
        return {
          scopeKey,
          jobs: [],
          failures: [],
          queueCount: names.length,
          blockedReason: `All-queue job browsing is limited to ${MAX_ALL_QUEUE_JOB_FANOUT} queues; ${formatNumber(names.length)} were discovered. Select one queue to avoid an unsafe request fan-out.`,
        };
      }
      const states = status === 'all' ? undefined : [status];
      // Pin URL + bearer for the whole pool. If Settings changes before React's
      // effect cleanup runs, remaining workers still cannot jump to the new
      // target; cleanup then aborts the pinned generation and stops the pool.
      const client = bq.createServerTargetClient(bq.captureServerRequestTarget(), signal);
      const settled = await settledPool(
        names,
        JOB_FANOUT,
        async (name) => {
          signal.throwIfAborted();
          const response = await client.jobsList(name, states, JOBS_PER_QUEUE);
          return response.jobs.map((job) => ({
            ...job,
            stacktrace: job.stacktrace ?? undefined,
            queue: job.queue ?? name,
          }));
        },
        signal
      );
      signal.throwIfAborted();
      const jobs: Job[] = [];
      const failures: JobsLoad['failures'] = [];
      settled.forEach((result, index) => {
        if (result.status === 'fulfilled') jobs.push(...result.value);
        else {
          failures.push({
            queue: names[index],
            message: result.reason instanceof Error ? result.reason.message : String(result.reason),
          });
        }
      });
      return {
        scopeKey,
        jobs: jobs.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)),
        failures,
        queueCount: names.length,
        blockedReason: null,
      };
    },
    [queue, status, qs, queueNames, scopeKey]
  );

  const {
    data: loaded,
    error: jobsError,
    loading,
    refetch,
  } = usePolledData(fetcher, [scopeKey], { intervalMs: 15000 });
  const activeLoad = loaded?.scopeKey === scopeKey ? loaded : null;
  const jobs = activeLoad?.blockedReason ? null : (activeLoad?.jobs ?? null);

  const { rows, matchingCount } = useMemo(() => {
    const list = jobs ?? [];
    const term = search.trim().toLowerCase();
    const filtered = term
      ? list.filter(
          (j) =>
            (typeof j.id === 'string' && j.id.toLowerCase().includes(term)) ||
            (jobDataName(j.data)?.toLowerCase().includes(term) ?? false)
        )
      : list;
    return { rows: filtered.slice(0, DISPLAY_LIMIT), matchingCount: filtered.length };
  }, [jobs, search]);

  const stats = overview?.stats;
  const rate = stats ? errorRate(stats.totalCompleted, stats.totalFailed) : null;
  const statsValue = (value: number | undefined) => (stats ? formatNumber(value) : '—');
  const allListsFailed =
    !!activeLoad &&
    activeLoad.queueCount > 0 &&
    activeLoad.failures.length === activeLoad.queueCount;
  const initialJobsLoading =
    (queue === ALL && !qs && !queuesError) || (loading && !activeLoad && !jobsError);

  let emptyMessage = 'No jobs found.';
  if (activeLoad?.blockedReason) {
    emptyMessage = activeLoad.blockedReason;
  } else if (queue === ALL && queuesError && !qs) {
    emptyMessage = `Queue discovery unavailable — ${queuesError.message}`;
  } else if (jobsError && !activeLoad) {
    emptyMessage = `Could not load jobs — ${jobsError.message}`;
  } else if (allListsFailed) {
    emptyMessage = `Could not load jobs from any of the ${activeLoad.queueCount} queues.`;
  } else if (search.trim() && activeLoad?.failures.length) {
    emptyMessage = 'No matching jobs in the queue results that could be loaded.';
  } else if (search.trim()) {
    emptyMessage = 'No jobs match this search.';
  }

  return (
    <div>
      <PageHeader
        title="Jobs Explorer"
        description="Browse, inspect, and manage individual jobs."
        live={
          !!activeLoad &&
          !queuesError &&
          !overviewError &&
          !jobsError &&
          !activeLoad.blockedReason &&
          activeLoad.failures.length === 0
        }
      />
      {queuesError && (
        <OfflineBanner
          message={`Queue discovery unavailable — ${queuesError.message}`}
          onRetry={refetchQueues}
        />
      )}
      {overviewError && (
        <OfflineBanner
          message={`Job totals unavailable — ${overviewError.message}`}
          onRetry={refetchOverview}
        />
      )}
      {jobsError && (
        <OfflineBanner message={`Could not load jobs — ${jobsError.message}`} onRetry={refetch} />
      )}
      {activeLoad?.blockedReason && <OfflineBanner message={activeLoad.blockedReason} />}
      {!!activeLoad?.failures.length && (
        <OfflineBanner
          message={`Could not load jobs from ${activeLoad.failures.length} of ${activeLoad.queueCount} queues: ${activeLoad.failures
            .slice(0, 3)
            .map((failure) => `${failure.queue} (${failure.message})`)
            .join(', ')}${activeLoad.failures.length > 3 ? ', …' : ''}`}
          onRetry={refetch}
        />
      )}

      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        <StatCard
          label="Total"
          value={
            stats
              ? formatNumber(
                  stats.totalCompleted + stats.totalFailed + stats.waiting + stats.active
                )
              : '—'
          }
          compact
        />
        <StatCard label="Waiting" value={statsValue(stats?.waiting)} tone="amber" compact />
        <StatCard label="Active" value={statsValue(stats?.active)} tone="blue" compact />
        <StatCard
          label="Completed"
          value={statsValue(stats?.totalCompleted)}
          tone="green"
          compact
        />
        <StatCard
          label="Failed"
          value={statsValue(stats?.totalFailed)}
          tone={stats?.totalFailed ? 'red' : 'default'}
          compact
        />
        <StatCard
          label="Error Rate"
          value={rate == null ? '—' : formatPercent(rate)}
          tone={rate == null ? 'default' : rate > 0.05 ? 'red' : 'green'}
          compact
        />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="w-48">
          <Select
            value={queue}
            aria-label="Queue"
            name="jobs-queue"
            autoComplete="off"
            onChange={(e) => setQueue(e.target.value)}
          >
            <option value={ALL}>All Queues</option>
            {(qs?.queues ?? []).map((q) => (
              <option key={q.name} value={q.name}>
                {q.name}
              </option>
            ))}
          </Select>
        </div>
        <SegmentedControl options={STATUS} value={status} onChange={setStatus} />
        <div className="relative ml-auto min-w-56 flex-1 md:max-w-xs">
          <IconSearch className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search jobs"
            name="jobs-search"
            autoComplete="off"
            placeholder="Search by ID or name…"
            className="h-9 w-full rounded-lg border border-line bg-surface pl-9 pr-3 text-sm text-fg placeholder:text-faint focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
        </div>
      </div>

      {activeLoad && !activeLoad.blockedReason && (
        <p role="status" className="mb-3 text-xs text-faint">
          {queue === ALL
            ? `Queried all ${formatNumber(activeLoad.queueCount)} discovered queues`
            : `Queried ${queue}`}{' '}
          · up to {JOBS_PER_QUEUE} recent jobs per queue
          {matchingCount > DISPLAY_LIMIT
            ? ` · showing the newest ${DISPLAY_LIMIT} of ${formatNumber(matchingCount)} matches`
            : ''}
        </p>
      )}

      {initialJobsLoading ? (
        <LoadingState label="Loading jobs…" />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-faint">
                <th className="px-5 py-3 font-medium">Job ID</th>
                <th className="px-5 py-3 font-medium">Name</th>
                <th className="px-5 py-3 font-medium">Queue</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 text-right font-medium">Priority</th>
                <th className="px-5 py-3 text-right font-medium">Created</th>
                <th className="px-5 py-3 text-right font-medium">Duration</th>
                <th className="w-12 px-5 py-3" />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-5 py-12 text-center text-sm text-faint">
                    {emptyMessage}
                  </td>
                </tr>
              ) : (
                rows.map((j) => (
                  <tr
                    key={`${j.queue}:${j.id}`}
                    className="border-b border-line last:border-0 hover:bg-surface-2/40"
                  >
                    <td className="px-5 py-3 font-mono text-xs">
                      <Link
                        to={`/job?id=${encodeURIComponent(j.id)}`}
                        className="text-accent/90 hover:text-accent hover:underline"
                        title={`Inspect job ${j.id}`}
                      >
                        {j.id}
                      </Link>
                    </td>
                    <td className="px-5 py-3 text-fg">
                      {j.name ?? jobDataName(j.data) ?? 'default'}
                    </td>
                    <td className="px-5 py-3 font-mono text-xs text-muted">{j.queue}</td>
                    <td className="px-5 py-3">
                      <StatusBadge status={String(j.state ?? j.status ?? 'waiting')} />
                    </td>
                    <td className="px-5 py-3 text-right tnum text-muted">{j.priority ?? 0}</td>
                    <td className="px-5 py-3 text-right text-faint">
                      {formatRelativeTime(j.createdAt)}
                    </td>
                    <td className="px-5 py-3 text-right tnum text-muted">
                      {formatDuration(
                        jobDuration(j.startedAt ?? undefined, j.completedAt ?? undefined)
                      )}
                    </td>
                    <td className="px-5 py-3 text-right">
                      <span className="text-xs text-faint" title={FLOW_DELETION_UNAVAILABLE}>
                        Delete unavailable
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
