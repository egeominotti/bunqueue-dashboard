import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { toast } from '@/components/dashboard/stores/toastStore';
import { Button, IconButton } from '@/components/ui/Button';
import { ErrorState, LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { Select } from '@/components/ui/form';
import { IconDownload, IconEye, IconPlay, IconSearch } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { StatCard } from '@/components/ui/StatCard';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { bq } from '@/lib/bq';
import type { JobFull } from '@/lib/bqTypes';
import { cn } from '@/lib/cn';
import { downloadCsv } from '@/lib/exportFile';
import {
  errorRate,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatPercent,
} from '@/lib/format';
import { actionGates } from '@/lib/jobActions';
import { usePolledData } from '@/lib/usePolledData';
import { assertSuccessfulMutationResponse, useServerActionGuard } from '@/lib/useServerActionGuard';

const STATUS = [
  'all',
  'waiting',
  'prioritized',
  'active',
  'delayed',
  'waiting-children',
  'paused',
  'completed',
  'failed',
] as const;
type StatusFilter = (typeof STATUS)[number];
const PAGE_SIZE = 25;

/**
 * Bulk-bar count. The bulk buttons only ever target rows the ID filter leaves
 * VISIBLE, so a bare `selected.size` next to them overstates what they do
 * ("25 selected" → 1 job acted on) whenever the filter hides selected rows.
 */
export function selectionLabel(visible: number, total: number): string {
  return visible === total
    ? `${total} selected`
    : `${visible} of ${total} selected match this filter`;
}

/** Drop only the ids a bulk action actually ran on — never the hidden rest. */
export function withoutActed(selected: Set<string>, actedIds: string[]): Set<string> {
  const next = new Set(selected);
  for (const id of actedIds) next.delete(id);
  return next;
}

function priorityLabel(p = 0) {
  if (p >= 10) return { t: 'HIGH', c: 'text-warning' };
  if (p >= 1) return { t: 'MEDIUM', c: 'text-blue-400' };
  return { t: 'LOW', c: 'text-faint' };
}

export function JobsPro() {
  const [params, setParams] = useSearchParams();
  const [queue, setQueue] = useState(params.get('queue') ?? '');
  const [status, setStatus] = useState<StatusFilter>(() => {
    const s = params.get('status') as StatusFilter | null;
    return s && STATUS.includes(s) ? s : 'all';
  });
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [actionMsg, setActionMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Queue dropdown: one /queues/summary call (all queues), polled slowly — the
  // queue set changes rarely, so it doesn't ride the fast job cadence.
  const {
    data: summary,
    error: discoveryError,
    loading: discoveryLoading,
    refetch: refetchSummary,
  } = usePolledData(() => bq.queuesSummary(), [], { intervalMs: 30000 });
  // `/dashboard` omits prioritized and waiting-children in v2.8.55. `/stats`
  // carries every state needed by the inventory cards.
  const {
    data: overview,
    error: overviewError,
    refetch: refetchOverview,
  } = usePolledData(() => bq.stats(), [], { intervalMs: 10000 });

  // Default to the first queue once the list arrives (there is no cross-queue
  // job-list endpoint, so jobs are always fetched one queue at a time, paginated
  // server-side — no N-queue fan-out).
  useEffect(() => {
    if (!queue && summary?.length) setQueue(summary[0].name);
  }, [summary, queue]);

  // Tagged with the view it was fetched for (queue|status|page), so switching
  // any of them can't leave the previous view's rows rendered — with live
  // action buttons — under the new selection for one round-trip.
  const view = `${queue}|${status}|${page}`;
  const actionGuard = useServerActionGuard(`jobs:${queue}`);
  const fetcher = useCallback(async () => {
    if (!queue) return { view, jobs: [] as JobFull[] };
    const states = status === 'all' ? undefined : [status];
    const r = await bq.jobsList(queue, states, PAGE_SIZE, page * PAGE_SIZE);
    return { view, jobs: (r.jobs ?? []).map((j) => ({ ...j, queue: j.queue ?? queue })) };
  }, [queue, status, page, view]);
  const { data: raw, error, loading, refetch } = usePolledData(fetcher, [queue, status, page]);
  const jobs = raw && raw.view === view ? raw.jobs : null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: scopeKey is the connection+queue lifecycle boundary
  useEffect(() => {
    setBusyIds(new Set());
    setBulkBusy(false);
    setActionMsg(null);
  }, [actionGuard.scopeKey]);

  // No `total` from jobs/list — a full page means there may be a next one.
  const hasNext = (jobs?.length ?? 0) === PAGE_SIZE;

  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return jobs ?? [];
    return (jobs ?? []).filter(
      (j) => j.id.toLowerCase().includes(term) || j.name?.toLowerCase().includes(term)
    );
  }, [jobs, search]);

  const stats = overview?.stats;
  // Recorded counts (stats.completed + per-queue failed sums) — the
  // totalCompleted/totalFailed session counters zero on every server restart.
  const failedTotal = useMemo(
    () => summary?.reduce((a, q) => a + (q.counts?.failed ?? 0), 0) ?? null,
    [summary]
  );
  const rate = stats && failedTotal != null ? errorRate(stats.completed, failedTotal) : null;
  // While the overview poll is still in flight the cards would render hard
  // zeros — a "0" that looks like data. Show placeholders until it arrives.
  const stat = (n: number | undefined) => (stats ? formatNumber(n) : '—');

  const resetPage = () => setPage(0);

  // Keep queue+status in the URL (replace, not push) so a filtered view is
  // shareable and survives back-navigation. Page is deliberately left out —
  // offsets go stale as jobs drain.
  const syncUrl = (q: string, s: StatusFilter) => {
    const next: Record<string, string> = {};
    if (q) next.queue = q;
    if (s !== 'all') next.status = s;
    setParams(next, { replace: true });
  };

  // A different page/queue/status shows different jobs — a selection made on
  // the old view must not silently carry over to rows it never referred to.
  // biome-ignore lint/correctness/useExhaustiveDependencies: clear on view change
  useEffect(() => {
    setSelected(new Set());
  }, [queue, status, page]);

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  // Membership-based (not size-based): search can shrink `rows` while stale
  // ids remain selected, and sizes would then lie.
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggleAll = () =>
    setSelected(() => (allSelected ? new Set() : new Set(rows.map((r) => r.id))));

  const runOne = async (
    job: JobFull,
    label: string,
    fn: () => Promise<unknown>,
    confirmText?: string
  ) => {
    if (confirmText && !window.confirm(confirmText)) return;
    const lease = actionGuard.begin(`job:${job.id}`);
    if (!lease) return;
    setBusyIds((s) => new Set(s).add(job.id));
    setActionMsg(null);
    try {
      const response = await fn();
      assertSuccessfulMutationResponse(response, label);
      if (!lease.isCurrent()) return;
      setActionMsg({ ok: true, text: `${label} ✓` });
      toast.success(`${label} ✓`, job.id);
      void refetch();
    } catch (e) {
      if (!lease.isCurrent()) return;
      setActionMsg({ ok: false, text: `${label} failed: ${(e as Error).message}` });
      toast.error(`${label} failed`, (e as Error).message);
    } finally {
      if (lease.finish()) {
        setBusyIds((s) => {
          const n = new Set(s);
          n.delete(job.id);
          return n;
        });
      }
    }
  };

  const runBulk = async (
    label: string,
    fn: (job: JobFull) => Promise<unknown>,
    // Only ELIGIBLE selected rows are targeted, so the confirm count matches
    // what actually runs (a mixed-state selection no longer overstates it) and
    // ineligible rows aren't attempted just to be rejected.
    eligible: (job: JobFull) => boolean,
    confirmText?: (count: number) => string
  ) => {
    const targets = rows.filter((r) => selected.has(r.id) && eligible(r));
    if (targets.length === 0) return;
    if (confirmText && !window.confirm(confirmText(targets.length))) return;
    // The bulk lock serializes bulk buttons; the per-id locks atomically keep a
    // targeted row action and this fan-out from mutating the same job together.
    const lease = actionGuard.begin(['bulk', ...targets.map((job) => `job:${job.id}`)]);
    if (!lease) return;
    setBulkBusy(true);
    setActionMsg(null);
    try {
      const results = await Promise.allSettled(
        targets.map(async (job) => {
          const response = await fn(job);
          assertSuccessfulMutationResponse(response, `${label} ${job.id}`);
        })
      );
      if (!lease.isCurrent()) return;
      const okCount = results.filter((r) => r.status === 'fulfilled').length;
      const failCount = results.length - okCount;
      const text = `${label}: ${okCount} succeeded${failCount ? `, ${failCount} failed` : ''}`;
      setActionMsg({ ok: failCount === 0, text });
      if (failCount === 0) toast.success(text);
      else toast.error(text);
      const actedIds = targets.map((t) => t.id);
      setSelected((s) => withoutActed(s, actedIds));
      void refetch();
    } finally {
      if (lease.finish()) setBulkBusy(false);
    }
  };

  // Per-action eligibility, shared by the button-enable check and runBulk's
  // target filter so the two can't drift.
  const eligibleFor = {
    promote: (j: JobFull) => actionGates(j.state).promote,
  };
  const selectedRows = rows.filter((r) => selected.has(r.id));
  const canBulk = {
    promote: selectedRows.some(eligibleFor.promote),
  };

  const exportRows = () => {
    if (rows.length === 0) {
      toast.info('No jobs to export on this page');
      return;
    }
    const out = rows.map((j) => ({
      id: j.id,
      name: j.name ?? 'default',
      queue: j.queue ?? queue,
      state: j.state ?? '',
      priority: j.priority ?? 0,
      attempts: j.attempts ?? 0,
      maxAttempts: j.maxAttempts ?? '',
      createdAt: j.createdAt ? new Date(j.createdAt).toISOString() : '',
      durationMs: j.startedAt && j.completedAt ? j.completedAt - j.startedAt : '',
    }));
    downloadCsv(`jobs-${queue}-${status}`, out, [
      'id',
      'name',
      'queue',
      'state',
      'priority',
      'attempts',
      'maxAttempts',
      'createdAt',
      'durationMs',
    ]);
  };

  // Targets are pre-filtered to eligible rows by runBulk, so each fn is a direct
  // call — no per-job state guard needed (it can never receive an ineligible job).
  const bulkPromote = () => runBulk('Promote', (j) => bq.promoteJob(j.id), eligibleFor.promote);
  return (
    <div>
      <PageHeader
        title="Jobs Explorer"
        description="Browse, inspect, and manage individual jobs."
        live={!!queue && jobs != null && !error && !discoveryError && !overviewError}
        actions={
          <Button size="sm" disabled={!jobs || rows.length === 0} onClick={exportRows}>
            <IconDownload className="size-3.5" /> Export CSV
          </Button>
        }
      />

      {discoveryError && (
        <OfflineBanner
          onRetry={refetchSummary}
          message={
            summary
              ? `Queue inventory refresh failed — showing the last successful queue totals. ${discoveryError.message}`
              : `Could not discover queues — ${discoveryError.message}. Select an existing queue from the URL or retry.`
          }
        />
      )}
      {overviewError && (
        <OfflineBanner
          onRetry={refetchOverview}
          message={
            overview
              ? `Server-wide totals refresh failed — showing the last successful totals. ${overviewError.message}`
              : `Server-wide job totals are unavailable — ${overviewError.message}. The selected queue page may still be current.`
          }
        />
      )}

      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4 xl:grid-cols-8">
        <StatCard
          label="Total"
          value={
            stats && failedTotal != null
              ? formatNumber(
                  stats.completed +
                    failedTotal +
                    stats.waiting +
                    stats.prioritized +
                    stats.active +
                    stats.delayed +
                    stats['waiting-children']
                )
              : '—'
          }
          hint="all queues"
          compact
        />
        <StatCard
          label="Waiting"
          value={stat(stats?.waiting)}
          tone="amber"
          hint="standard priority"
          compact
        />
        <StatCard label="Prioritized" value={stat(stats?.prioritized)} tone="amber" compact />
        <StatCard label="Active" value={stat(stats?.active)} tone="blue" compact />
        <StatCard
          label="Flow-blocked"
          value={stat(stats?.['waiting-children'])}
          tone="blue"
          compact
        />
        <StatCard label="Completed" value={stat(stats?.completed)} tone="green" compact />
        <StatCard
          label="Failed"
          value={failedTotal == null ? '—' : formatNumber(failedTotal)}
          tone={failedTotal != null && failedTotal > 0 ? 'red' : 'default'}
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
            onChange={(e) => {
              setQueue(e.target.value);
              resetPage();
              syncUrl(e.target.value, status);
            }}
          >
            {(summary ?? []).map((x) => (
              <option key={x.name} value={x.name}>
                {x.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-48">
          <Select
            aria-label="Job state"
            name="jobs-state"
            value={status}
            onChange={(event) => {
              const v = event.target.value as StatusFilter;
              setStatus(v);
              resetPage();
              syncUrl(queue, v);
            }}
          >
            {STATUS.map((state) => (
              <option key={state} value={state}>
                {state === 'all' ? 'All states' : state}
              </option>
            ))}
          </Select>
        </div>
        <div className="relative ml-auto min-w-56 flex-1 md:max-w-xs">
          <IconSearch className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter this page by ID or name…"
            aria-label="Filter by job ID or name"
            name="jobs-id-filter"
            autoComplete="off"
            className="h-9 w-full rounded-lg border border-line bg-surface pl-9 pr-3 text-sm text-fg placeholder:text-faint focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
        </div>
      </div>

      {selected.size > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface-2 px-4 py-2 text-sm">
          {/* The bulk actions only ever touch VISIBLE rows, so the count must
              be the visible one — a search filter can hide selected rows and
              "25 selected" next to buttons that act on 1 is a lie. */}
          <span className="mr-1 text-muted">
            {selectionLabel(selectedRows.length, selected.size)}
          </span>
          {canBulk.promote && (
            <Button size="sm" disabled={bulkBusy} onClick={bulkPromote}>
              Promote selected
            </Button>
          )}
          {!canBulk.promote && (
            <span className="text-xs text-faint">
              {selectedRows.length === 0
                ? 'The selected jobs are hidden by the filter — clear it to act on them.'
                : 'No actions apply to the selected job states.'}
            </span>
          )}
        </div>
      )}

      {actionMsg && (
        <div
          role="status"
          className={cn('mb-3 text-sm', actionMsg.ok ? 'text-success' : 'text-danger')}
        >
          {actionMsg.text}
        </div>
      )}

      {error && jobs && (
        <OfflineBanner
          message="Job refresh failed — showing the last successful page."
          onRetry={refetch}
        />
      )}

      {error && !jobs ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : discoveryLoading && !summary && !queue && !discoveryError ? (
        <LoadingState label="Discovering queues…" />
      ) : loading && !jobs ? (
        <LoadingState label="Loading jobs…" />
      ) : (
        <>
          {/* The stat cards above are server-wide; say what the table itself shows. */}
          {queue && (
            <div className="mb-2 flex items-center gap-2 text-sm">
              <span className="text-faint">Jobs in queue</span>
              <span className="rounded-md bg-surface-2 px-2 py-0.5 font-mono text-xs text-fg">
                {queue}
              </span>
            </div>
          )}
          <div className="overflow-x-auto rounded-xl border border-line bg-surface">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-faint">
                  <th scope="col" className="w-10 px-5 py-3">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      ref={(element) => {
                        if (element) {
                          element.indeterminate = selected.size > 0 && !allSelected;
                        }
                      }}
                      aria-checked={selected.size > 0 && !allSelected ? 'mixed' : allSelected}
                      onChange={toggleAll}
                      aria-label="Select all jobs on page"
                      className="accent-accent"
                    />
                  </th>
                  <th scope="col" className="px-5 py-3 font-medium">
                    Job ID
                  </th>
                  <th scope="col" className="px-5 py-3 font-medium">
                    Name
                  </th>
                  <th scope="col" className="px-5 py-3 font-medium">
                    Status
                  </th>
                  <th scope="col" className="px-5 py-3 font-medium">
                    Priority
                  </th>
                  <th scope="col" className="px-5 py-3 text-right font-medium">
                    Created
                  </th>
                  <th scope="col" className="px-5 py-3 text-right font-medium">
                    Duration
                  </th>
                  <th scope="col" className="w-28 px-5 py-3 text-right font-medium">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-5 py-12 text-center text-sm text-faint">
                      {search.trim()
                        ? 'No jobs on this page match your ID or name filter.'
                        : queue
                          ? 'No jobs found.'
                          : discoveryError
                            ? 'Queue discovery failed. Retry above.'
                            : 'Select a queue.'}
                    </td>
                  </tr>
                ) : (
                  rows.map((j) => {
                    const pr = priorityLabel(j.priority);
                    const gates = actionGates(j.state);
                    const rowBusy = bulkBusy || busyIds.has(j.id);
                    return (
                      <tr
                        key={j.id}
                        className="border-b border-line last:border-0 hover:bg-surface-2/40"
                      >
                        <td className="px-5 py-3">
                          <input
                            type="checkbox"
                            checked={selected.has(j.id)}
                            onChange={() => toggle(j.id)}
                            aria-label={`Select job ${j.id}`}
                            className="accent-accent"
                          />
                        </td>
                        <td className="px-5 py-3 font-mono text-xs text-accent/90">
                          {/* max-w on the td is ignored in auto table layout — truncate a block span instead. */}
                          <span className="block max-w-[16rem] truncate" title={j.id}>
                            {j.id}
                          </span>
                        </td>
                        <td className="px-5 py-3 font-mono text-xs text-muted">
                          {j.name ?? 'default'}
                        </td>
                        <td className="px-5 py-3">
                          <StatusBadge status={String(j.state ?? 'waiting')} />
                        </td>
                        <td className={cn('px-5 py-3 text-xs font-semibold', pr.c)}>{pr.t}</td>
                        <td className="px-5 py-3 text-right text-faint">
                          {formatDateTime(j.createdAt)}
                        </td>
                        <td className="px-5 py-3 text-right tnum text-muted">
                          {formatDuration(
                            j.startedAt && j.completedAt ? j.completedAt - j.startedAt : undefined
                          )}
                        </td>
                        <td className="px-5 py-3">
                          <div className="flex justify-end gap-1">
                            <Link
                              to={`/job?id=${encodeURIComponent(j.id)}`}
                              aria-label={`Inspect job ${j.id}`}
                              className="inline-flex size-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                            >
                              <IconEye className="size-3.5" />
                            </Link>
                            {gates.promote && (
                              <IconButton
                                aria-label="Promote job"
                                disabled={rowBusy}
                                onClick={() => runOne(j, 'Promote', () => bq.promoteJob(j.id))}
                              >
                                <IconPlay className="size-3.5" />
                              </IconButton>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            hasNext={hasNext}
            onPageChange={setPage}
            label="jobs"
          />
        </>
      )}
    </div>
  );
}
