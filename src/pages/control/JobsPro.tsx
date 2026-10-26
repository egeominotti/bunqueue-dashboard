import { useCallback, useMemo, useState } from 'react';
import { toast } from '@/components/dashboard/stores/toastStore';
import { Button } from '@/components/ui/Button';
import { ErrorState, LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { IconDownload } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { bq } from '@/lib/bq';
import type { JobFull } from '@/lib/bqTypes';
import { errorRate, formatNumber, formatPercent } from '@/lib/format';
import { actionGates } from '@/lib/jobActions';
import { usePolledData } from '@/lib/usePolledData';
import { downloadJobsCsv } from './jobsPro/exportJobs';
import { JobsStats } from './jobsPro/JobsStats';
import { JobsTable } from './jobsPro/JobsTable';
import { JobsToolbar } from './jobsPro/JobsToolbar';
import { JOBS_PAGE_SIZE } from './jobsPro/model';
import { useJobMutations } from './jobsPro/useJobMutations';
import { useJobsExport } from './jobsPro/useJobsExport';
import { useJobsView } from './jobsPro/useJobsView';

export { selectionLabel, withoutActed } from './jobsPro/model';

export function JobsPro() {
  const [search, setSearch] = useState('');

  // Queue dropdown: one /queues/summary call (all queues), polled slowly — the
  // queue set changes rarely, so it doesn't ride the fast job cadence.
  const {
    data: summary,
    error: discoveryError,
    loading: discoveryLoading,
    refetch: refetchSummary,
  } = usePolledData(() => bq.queuesSummary(), [], { intervalMs: 30000 });
  const { queue, status, page, view, selected, setSelected, setPage, selectQueue, selectStatus } =
    useJobsView(summary);
  const { busy: exportBusy, exportAll } = useJobsExport(queue, status, search);
  // `/dashboard` omits prioritized and waiting-children in v2.9.3. `/stats`
  // carries every state needed by the inventory cards.
  const {
    data: overview,
    error: overviewError,
    refetch: refetchOverview,
  } = usePolledData(() => bq.stats(), [], { intervalMs: 10000 });

  // Tagged with the view it was fetched for (queue|status|page), so switching
  // any of them can't leave the previous view's rows rendered — with live
  // action buttons — under the new selection for one round-trip.
  const fetcher = useCallback(async () => {
    if (!queue) return { view, jobs: [] as JobFull[] };
    const states = status === 'all' ? undefined : [status];
    const r = await bq.jobsList(queue, states, JOBS_PAGE_SIZE, page * JOBS_PAGE_SIZE);
    return { view, jobs: (r.jobs ?? []).map((j) => ({ ...j, queue: j.queue ?? queue })) };
  }, [queue, status, page, view]);
  const {
    data: raw,
    error,
    loading,
    refetch,
  } = usePolledData(fetcher, [queue, status, page, view]);
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
    view,
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
    downloadJobsCsv(queue, status, rows);
  };

  // Targets are pre-filtered to eligible rows by runBulk, so each fn is a direct
  // call — no per-job state guard needed (it can never receive an ineligible job).
  const bulkPromote = () => runBulk('Promote', (j) => bq.promoteJob(j.id), eligibleFor.promote);
  return (
    <div>
      <PageHeader
        title="Jobs Explorer"
        description="Browse, inspect, and manage individual jobs. Full CSV exports read up to 10,000 live jobs and can reflect concurrent changes."
        live={!!queue && jobs != null && !error && !discoveryError && !overviewError}
        actions={
          <>
            <Button size="sm" disabled={!jobs || rows.length === 0} onClick={exportRows}>
              <IconDownload className="size-3.5" /> Export page CSV
            </Button>
            <Button
              size="sm"
              disabled={!queue || !jobs || exportBusy}
              onClick={() => void exportAll()}
              title="Export matching jobs across all pages for this queue and state"
            >
              <IconDownload className="size-3.5" />
              {exportBusy ? 'Exporting…' : 'Export all matching CSV'}
            </Button>
          </>
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
        onQueue={selectQueue}
        onStatus={selectStatus}
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
