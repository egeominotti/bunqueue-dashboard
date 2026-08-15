import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from '@/components/dashboard/stores/toastStore';
import { Button } from '@/components/ui/Button';
import { ErrorState, LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { IconDownload } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { bq } from '@/lib/bq';
import type { JobFull } from '@/lib/bqTypes';
import { downloadCsv } from '@/lib/exportFile';
import { errorRate, formatNumber, formatPercent } from '@/lib/format';
import { actionGates } from '@/lib/jobActions';
import { usePolledData } from '@/lib/usePolledData';
import { JobsStats } from './jobsPro/JobsStats';
import { JobsTable } from './jobsPro/JobsTable';
import { JobsToolbar } from './jobsPro/JobsToolbar';
import { JOB_STATUSES, JOBS_PAGE_SIZE, type JobStatusFilter } from './jobsPro/model';
import { useJobMutations } from './jobsPro/useJobMutations';

export { selectionLabel, withoutActed } from './jobsPro/model';

export function JobsPro() {
  const [params, setParams] = useSearchParams();
  const [queue, setQueue] = useState(params.get('queue') ?? '');
  const [status, setStatus] = useState<JobStatusFilter>(() => {
    const s = params.get('status') as JobStatusFilter | null;
    return s && JOB_STATUSES.includes(s) ? s : 'all';
  });
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Queue dropdown: one /queues/summary call (all queues), polled slowly — the
  // queue set changes rarely, so it doesn't ride the fast job cadence.
  const {
    data: summary,
    error: discoveryError,
    loading: discoveryLoading,
    refetch: refetchSummary,
  } = usePolledData(() => bq.queuesSummary(), [], { intervalMs: 30000 });
  // `/dashboard` omits prioritized and waiting-children in v2.8.59. `/stats`
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
  const fetcher = useCallback(async () => {
    if (!queue) return { view, jobs: [] as JobFull[] };
    const states = status === 'all' ? undefined : [status];
    const r = await bq.jobsList(queue, states, JOBS_PAGE_SIZE, page * JOBS_PAGE_SIZE);
    return { view, jobs: (r.jobs ?? []).map((j) => ({ ...j, queue: j.queue ?? queue })) };
  }, [queue, status, page, view]);
  const { data: raw, error, loading, refetch } = usePolledData(fetcher, [queue, status, page]);
  const jobs = raw?.view === view ? raw.jobs : null;

  // No `total` from jobs/list — a full page means there may be a next one.
  const hasNext = (jobs?.length ?? 0) === JOBS_PAGE_SIZE;

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
  const syncUrl = (q: string, s: JobStatusFilter) => {
    const next: Record<string, string> = {};
    if (q) next.queue = q;
    if (s !== 'all') next.status = s;
    setParams(next, { replace: true });
  };

  // A different page/queue/status shows different jobs — a selection made on
  // the old view must not silently carry over to rows it never referred to.
  // Clear selection whenever the rendered view changes.
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

  const { actionMsg, bulkBusy, busyIds, runBulk, runOne } = useJobMutations({
    queue,
    rows,
    selected,
    setSelected,
    refetch,
  });

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

      <JobsStats
        total={
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
        waiting={stat(stats?.waiting)}
        prioritized={stat(stats?.prioritized)}
        active={stat(stats?.active)}
        flowBlocked={stat(stats?.['waiting-children'])}
        completed={stat(stats?.completed)}
        failed={failedTotal == null ? '—' : formatNumber(failedTotal)}
        failedCount={failedTotal}
        errorRate={rate == null ? '—' : formatPercent(rate)}
        errorRateTone={rate == null ? 'default' : rate > 0.05 ? 'red' : 'green'}
      />
      <JobsToolbar
        queue={queue}
        summary={summary ?? []}
        status={status}
        search={search}
        selectedTotal={selected.size}
        selectedVisible={selectedRows.length}
        canPromote={canBulk.promote}
        bulkBusy={bulkBusy}
        onQueue={(next) => {
          setQueue(next);
          resetPage();
          syncUrl(next, status);
        }}
        onStatus={(next) => {
          setStatus(next);
          resetPage();
          syncUrl(queue, next);
        }}
        onSearch={setSearch}
        onPromote={bulkPromote}
      />

      {actionMsg && (
        <div
          role="status"
          className={`mb-3 text-sm ${actionMsg.ok ? 'text-success' : 'text-danger'}`}
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
        <JobsTable
          queue={queue}
          rows={rows}
          search={search}
          discoveryError={!!discoveryError}
          selected={selected}
          allSelected={allSelected}
          bulkBusy={bulkBusy}
          busyIds={busyIds}
          page={page}
          hasNext={hasNext}
          onToggleAll={toggleAll}
          onToggle={toggle}
          onRun={(job, label, operation) => void runOne(job, label, operation)}
          onPage={setPage}
        />
      )}
    </div>
  );
}
