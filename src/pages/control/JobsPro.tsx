import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { toast } from '@/components/dashboard/stores/toastStore';
import { Button, IconButton } from '@/components/ui/Button';
import { LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { SegmentedControl, Select } from '@/components/ui/form';
import {
  IconClose,
  IconDownload,
  IconEye,
  IconPlay,
  IconRefresh,
  IconSearch,
  IconTrash,
} from '@/components/ui/icons';
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

const STATUS = ['all', 'waiting', 'active', 'completed', 'failed'] as const;
type StatusFilter = (typeof STATUS)[number];
const PAGE_SIZE = 25;

/**
 * Bulk-bar count. The bulk buttons only ever target rows the ID filter leaves
 * VISIBLE, so a bare `selected.size` next to them overstates what they do
 * ("25 selected" → 1 job cancelled) whenever the filter hides selected rows.
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

/** Route a job to whichever retry endpoint applies to its current state. */
function retryJobByState(j: JobFull): Promise<unknown> {
  const g = actionGates(j.state);
  if (g.retryActive) return bq.retryJob(j.id);
  if (g.retryDlq) return bq.retryDlq(j.queue ?? '', j.id);
  return Promise.reject(new Error(`"${j.state ?? 'unknown'}" is not retryable`));
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
  const { data: summary } = usePolledData(() => bq.queuesSummary(), [], { intervalMs: 30000 });
  // Server-wide totals for the stat cards — slower cadence than the job table.
  const { data: overview } = usePolledData(() => bq.overview(), [], { intervalMs: 10000 });

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
  const fetcher = useCallback(async () => {
    if (!queue) return { view, jobs: [] as JobFull[] };
    const states = status === 'all' ? undefined : [status];
    const r = await bq.jobsList(queue, states, PAGE_SIZE, page * PAGE_SIZE);
    return { view, jobs: (r.jobs ?? []).map((j) => ({ ...j, queue: j.queue ?? queue })) };
  }, [queue, status, page, view]);
  const { data: raw, error, loading, refetch } = usePolledData(fetcher, [queue, status, page]);
  const jobs = raw && raw.view === view ? raw.jobs : null;

  // No `total` from jobs/list — a full page means there may be a next one.
  const hasNext = (jobs?.length ?? 0) === PAGE_SIZE;

  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return jobs ?? [];
    return (jobs ?? []).filter((j) => j.id.toLowerCase().includes(term));
  }, [jobs, search]);

  const stats = overview?.stats;
  // Recorded counts (stats.completed + per-queue failed sums) — the
  // totalCompleted/totalFailed session counters zero on every server restart.
  const failedTotal = useMemo(
    () => (summary ?? []).reduce((a, q) => a + (q.counts?.failed ?? 0), 0),
    [summary]
  );
  const rate = stats ? errorRate(stats.completed, failedTotal) : null;
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
    setBusyIds((s) => new Set(s).add(job.id));
    setActionMsg(null);
    try {
      await fn();
      setActionMsg({ ok: true, text: `${label} ✓` });
      toast.success(`${label} ✓`, job.id);
    } catch (e) {
      setActionMsg({ ok: false, text: `${label} failed: ${(e as Error).message}` });
      toast.error(`${label} failed`, (e as Error).message);
    } finally {
      setBusyIds((s) => {
        const n = new Set(s);
        n.delete(job.id);
        return n;
      });
      refetch();
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
    setBulkBusy(true);
    setActionMsg(null);
    const results = await Promise.allSettled(targets.map(fn));
    const okCount = results.filter((r) => r.status === 'fulfilled').length;
    const failCount = results.length - okCount;
    const text = `${label}: ${okCount} succeeded${failCount ? `, ${failCount} failed` : ''}`;
    setActionMsg({ ok: failCount === 0, text });
    if (failCount === 0) toast.success(text);
    else toast.error(text);
    const actedIds = targets.map((t) => t.id);
    setSelected((s) => withoutActed(s, actedIds));
    setBulkBusy(false);
    refetch();
  };

  // Per-action eligibility, shared by the button-enable check and runBulk's
  // target filter so the two can't drift.
  const eligibleFor = {
    retry: (j: JobFull) => {
      const g = actionGates(j.state);
      return g.retryActive || g.retryDlq;
    },
    promote: (j: JobFull) => actionGates(j.state).promote,
    requeue: (j: JobFull) => actionGates(j.state).requeueCompleted,
    fail: (j: JobFull) => actionGates(j.state).fail,
    cancel: (j: JobFull) => actionGates(j.state).cancel,
  };
  const selectedRows = rows.filter((r) => selected.has(r.id));
  const canBulk = {
    retry: selectedRows.some(eligibleFor.retry),
    promote: selectedRows.some(eligibleFor.promote),
    requeue: selectedRows.some(eligibleFor.requeue),
    fail: selectedRows.some(eligibleFor.fail),
    cancel: selectedRows.some(eligibleFor.cancel),
  };

  const exportRows = () => {
    if (rows.length === 0) {
      toast.info('No jobs to export on this page');
      return;
    }
    const out = rows.map((j) => ({
      id: j.id,
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
  const bulkRetry = () => runBulk('Retry', retryJobByState, eligibleFor.retry);
  const bulkPromote = () => runBulk('Promote', (j) => bq.promoteJob(j.id), eligibleFor.promote);
  const bulkRequeue = () =>
    runBulk('Requeue', (j) => bq.retryCompleted(j.queue ?? '', j.id), eligibleFor.requeue);
  const bulkFail = () =>
    runBulk(
      'Fail',
      (j) => bq.failJob(j.id),
      eligibleFor.fail,
      (n) => `Force-fail ${n} job(s)?`
    );
  const bulkCancel = () =>
    runBulk(
      'Cancel',
      (j) => bq.cancelJob(j.id),
      eligibleFor.cancel,
      (n) => `Cancel ${n} job(s)? This cannot be undone.`
    );

  return (
    <div>
      <PageHeader
        title="Jobs Explorer"
        description="Browse, inspect, and manage individual jobs."
        live
        actions={
          <Button size="sm" disabled={!jobs || rows.length === 0} onClick={exportRows}>
            <IconDownload className="size-3.5" /> Export CSV
          </Button>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        <StatCard
          label="Total"
          value={stat(
            (stats?.completed ?? 0) +
              failedTotal +
              (stats?.waiting ?? 0) +
              (stats?.active ?? 0) +
              (stats?.delayed ?? 0)
          )}
          hint="all queues"
          compact
        />
        <StatCard label="Waiting" value={stat(stats?.waiting)} tone="amber" compact />
        <StatCard label="Active" value={stat(stats?.active)} tone="blue" compact />
        <StatCard label="Completed" value={stat(stats?.completed)} tone="green" compact />
        <StatCard
          label="Failed"
          value={stat(failedTotal)}
          tone={failedTotal ? 'red' : 'default'}
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
        <SegmentedControl
          options={STATUS}
          value={status}
          onChange={(v) => {
            setStatus(v);
            resetPage();
            syncUrl(queue, v);
          }}
        />
        <div className="relative ml-auto min-w-56 flex-1 md:max-w-xs">
          <IconSearch className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter this page by ID…"
            aria-label="Filter by job ID"
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
          {canBulk.retry && (
            <Button size="sm" disabled={bulkBusy} onClick={bulkRetry}>
              Retry selected
            </Button>
          )}
          {canBulk.promote && (
            <Button size="sm" disabled={bulkBusy} onClick={bulkPromote}>
              Promote selected
            </Button>
          )}
          {canBulk.requeue && (
            <Button size="sm" disabled={bulkBusy} onClick={bulkRequeue}>
              Requeue selected
            </Button>
          )}
          {canBulk.fail && (
            <Button variant="warning" size="sm" disabled={bulkBusy} onClick={bulkFail}>
              Fail selected
            </Button>
          )}
          {canBulk.cancel && (
            <Button variant="danger" size="sm" disabled={bulkBusy} onClick={bulkCancel}>
              Cancel selected
            </Button>
          )}
          {!canBulk.retry &&
            !canBulk.promote &&
            !canBulk.requeue &&
            !canBulk.fail &&
            !canBulk.cancel && (
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

      {error && <OfflineBanner onRetry={refetch} />}

      {loading && !jobs && !error ? (
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
                      onChange={toggleAll}
                      aria-label="Select all jobs on page"
                      className="accent-accent"
                    />
                  </th>
                  <th scope="col" className="px-5 py-3 font-medium">
                    Job ID
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
                    <td colSpan={7} className="px-5 py-12 text-center text-sm text-faint">
                      {search.trim()
                        ? 'No jobs on this page match your ID filter.'
                        : queue
                          ? 'No jobs found.'
                          : 'Select a queue.'}
                    </td>
                  </tr>
                ) : (
                  rows.map((j) => {
                    const pr = priorityLabel(j.priority);
                    const gates = actionGates(j.state);
                    const rowBusy = busyIds.has(j.id);
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
                            <Link to={`/job?id=${encodeURIComponent(j.id)}`}>
                              <IconButton aria-label="Inspect job">
                                <IconEye className="size-3.5" />
                              </IconButton>
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
                            {(gates.retryActive || gates.retryDlq) && (
                              <IconButton
                                aria-label="Retry job"
                                disabled={rowBusy}
                                onClick={() => runOne(j, 'Retry', () => retryJobByState(j))}
                              >
                                <IconRefresh className="size-3.5" />
                              </IconButton>
                            )}
                            {gates.requeueCompleted && (
                              <IconButton
                                aria-label="Requeue job"
                                disabled={rowBusy}
                                onClick={() =>
                                  runOne(j, 'Requeue', () => bq.retryCompleted(j.queue ?? '', j.id))
                                }
                              >
                                <IconRefresh className="size-3.5" />
                              </IconButton>
                            )}
                            {gates.fail && (
                              <IconButton
                                aria-label="Fail job"
                                disabled={rowBusy}
                                onClick={() =>
                                  runOne(
                                    j,
                                    'Fail',
                                    () => bq.failJob(j.id),
                                    'Force-fail this active job?'
                                  )
                                }
                              >
                                <IconClose className="size-3.5" />
                              </IconButton>
                            )}
                            {gates.cancel && (
                              <IconButton
                                aria-label="Cancel job"
                                disabled={rowBusy}
                                onClick={() =>
                                  runOne(j, 'Cancel', () => bq.cancelJob(j.id), 'Cancel this job?')
                                }
                              >
                                <IconTrash className="size-3.5" />
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
