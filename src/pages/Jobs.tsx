import { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { SegmentedControl, Select } from '@/components/ui/form';
import { IconSearch } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatCard } from '@/components/ui/StatCard';
import { api } from '@/lib/api';
import { bq } from '@/lib/bq';
import { errorRate, formatNumber, formatPercent } from '@/lib/format';
import { settledPool } from '@/lib/promisePool';
import type { Job } from '@/lib/types';
import { usePolledData } from '@/lib/usePolledData';
import { ClassicJobsTable } from './jobs/ClassicJobsTable';
import {
  ALL_QUEUES,
  DISPLAY_LIMIT,
  discoverAllQueues,
  JOB_STATUS,
  JOBS_PER_QUEUE,
  type JobsLoad,
  jobDataName,
  MAX_ALL_QUEUE_JOB_FANOUT,
  type StatusFilter,
} from './jobs/classicJobsData';

export { discoverAllQueues, jobDataName, MAX_ALL_QUEUE_JOB_FANOUT } from './jobs/classicJobsData';

const JOB_FANOUT = 8;

export function Jobs() {
  const [params] = useSearchParams();
  const [queue, setQueue] = useState(params.get('queue') ?? ALL_QUEUES);
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
      if (queue === ALL_QUEUES && !qs) return null;
      const names = queue === ALL_QUEUES ? queueNames : [queue];
      if (queue === ALL_QUEUES && names.length > MAX_ALL_QUEUE_JOB_FANOUT) {
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
    (queue === ALL_QUEUES && !qs && !queuesError) || (loading && !activeLoad && !jobsError);

  let emptyMessage = 'No jobs found.';
  if (activeLoad?.blockedReason) {
    emptyMessage = activeLoad.blockedReason;
  } else if (queue === ALL_QUEUES && queuesError && !qs) {
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
            <option value={ALL_QUEUES}>All Queues</option>
            {(qs?.queues ?? []).map((q) => (
              <option key={q.name} value={q.name}>
                {q.name}
              </option>
            ))}
          </Select>
        </div>
        <SegmentedControl options={JOB_STATUS} value={status} onChange={setStatus} />
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
          {queue === ALL_QUEUES
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
        <ClassicJobsTable rows={rows} emptyMessage={emptyMessage} />
      )}
    </div>
  );
}
