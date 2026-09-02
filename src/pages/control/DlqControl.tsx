import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from '@/components/dashboard/stores/toastStore';
import { Button } from '@/components/ui/Button';
import { EmptyState, ErrorState, LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { IconDlq, IconDownload, IconRefresh } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { bq } from '@/lib/bq';
import type { DlqEntryFull } from '@/lib/bqTypes';
import { downloadCsv } from '@/lib/exportFile';
import { FLOW_BULK_RETRY_UNAVAILABLE, FLOW_DELETION_UNAVAILABLE } from '@/lib/flowMutationSafety';
import { usePolledData } from '@/lib/usePolledData';
import { DlqStatsCards, DlqToolbar } from './dlq/DlqControlSections';
import { DlqRow } from './dlq/DlqRow';
import { loadAllQueuePages } from './QueueControl';

const PAGE_SIZE = 25;
const EMPTY_BY_REASON: Record<string, number> = {};
const EMPTY_ENTRIES: DlqEntryFull[] = [];

const rowKey = (e: DlqEntryFull) => `${e.job.id}-${e.enteredAt}`;

export function DlqControl() {
  const [queue, setQueue] = useState('');
  const [page, setPage] = useState(0);
  const [reason, setReason] = useState('all');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const {
    data: qs,
    error: discoveryError,
    loading: discoveryLoading,
    refetch: refetchQueues,
  } = usePolledData(loadAllQueuePages, [], { intervalMs: 30000 });

  useEffect(() => {
    if (queue || !qs?.queues?.length) return;
    setQueue((qs.queues.find((x) => x.dlq > 0) ?? qs.queues[0]).name);
  }, [qs, queue]);

  // Tagged with queue+page (QueueControl pattern): a queue switch must not
  // leave the old queue's entries rendered under the new queue heading.
  const fetcher = useCallback(async () => {
    if (!queue)
      return {
        queue,
        page,
        entries: [] as DlqEntryFull[],
        total: 0,
        stats: null,
        statsError: null as string | null,
      };
    const [list, statsResult] = await Promise.all([
      bq.dlq(queue, PAGE_SIZE, page * PAGE_SIZE),
      bq
        .dlqStats(queue)
        .then((result) => ({ stats: result.stats, error: null as string | null }))
        .catch((statsError: unknown) => ({
          stats: null,
          error: (statsError as Error).message || 'Unknown error',
        })),
    ]);
    return {
      queue,
      page,
      entries: list.entries ?? [],
      total: list.total ?? 0,
      stats: statsResult.stats,
      statsError: statsResult.error,
    };
  }, [queue, page]);
  const { data: raw, error, loading, refetch } = usePolledData(fetcher, [queue, page]);
  const data = raw?.queue === queue && raw.page === page ? raw : null;

  // Clamp the page when the DLQ shrinks externally so a stale offset cannot
  // render "empty" while entries remain.
  useEffect(() => {
    if (!data) return;
    const last = Math.max(0, Math.ceil((data.total ?? 0) / PAGE_SIZE) - 1);
    if (page > last) setPage(last);
  }, [data, page]);

  // Selecting a different queue/page shows different rows — drop any expanded
  // detail panels so they can't render against rows that no longer exist.
  // Collapse expanded rows whenever the rendered view changes.
  useEffect(() => {
    setExpanded(new Set());
  }, [queue, page]);

  const byReason = data?.stats?.byReason ?? EMPTY_BY_REASON;
  const reasons = useMemo(() => Object.keys(byReason).filter((r) => byReason[r] > 0), [byReason]);
  const topReason = useMemo(
    () => [...reasons].sort((a, b) => (byReason[b] ?? 0) - (byReason[a] ?? 0))[0],
    [reasons, byReason]
  );

  const allEntries = data?.entries ?? EMPTY_ENTRIES;
  const entries = useMemo(() => {
    let list = allEntries;
    if (reason !== 'all') list = list.filter((e) => e.reason === reason);
    const term = search.trim().toLowerCase();
    if (term) list = list.filter((e) => e.job.id.toLowerCase().includes(term));
    return [...list].sort((a, b) => b.enteredAt - a.enteredAt);
  }, [allEntries, reason, search]);

  const filterActive = reason !== 'all' || search.trim() !== '';
  const pageScoped = (data?.total ?? 0) > PAGE_SIZE;

  const toggleExpand = (key: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      n.has(key) ? n.delete(key) : n.add(key);
      return n;
    });

  // Export exactly what's on screen (filtered + sorted), so the CSV matches the
  // table the operator is looking at rather than the raw unsorted page.
  const exportEntries = () => {
    if (entries.length === 0) {
      toast.info('Nothing to export');
      return;
    }
    downloadCsv(
      `dlq-${queue}`,
      entries.map((e) => ({
        jobId: e.job.id,
        reason: e.reason,
        error: e.error ?? '',
        attempts: e.job.attempts ?? e.attempts?.length ?? '',
        enteredAt: new Date(e.enteredAt).toISOString(),
      })),
      ['jobId', 'reason', 'error', 'attempts', 'enteredAt']
    );
  };

  return (
    <div>
      <PageHeader
        title="DLQ Control"
        description="Inspect and triage one queue's dead-lettered jobs."
        live={!!queue && !!data && !data.statsError && !error && !discoveryError}
        actions={
          <>
            <Button size="sm" disabled={!queue || !entries.length} onClick={exportEntries}>
              <IconDownload className="size-3.5" /> Export
            </Button>
            <Button size="sm" disabled title={FLOW_BULK_RETRY_UNAVAILABLE}>
              <IconRefresh className="size-3.5" /> Retry all
            </Button>
            <Button variant="danger" size="sm" disabled title={FLOW_DELETION_UNAVAILABLE}>
              Purge
            </Button>
          </>
        }
      />

      {error && data && (
        <OfflineBanner
          message="DLQ refresh failed — showing the last successful page."
          onRetry={refetch}
        />
      )}
      {discoveryError && (
        <OfflineBanner
          onRetry={refetchQueues}
          message={`Could not discover queues — ${discoveryError.message}. Retry before selecting a queue.`}
        />
      )}
      {data?.statsError && (
        <OfflineBanner
          message={`DLQ statistics are unavailable — ${data.statsError}. The entry list may still be current.`}
          onRetry={refetch}
        />
      )}

      <DlqStatsCards queue={queue} data={data} reasons={reasons} topReason={topReason} />
      <DlqToolbar
        queue={queue}
        queues={qs?.queues ?? []}
        reason={reason}
        reasons={reasons}
        byReason={byReason}
        search={search}
        pageScoped={pageScoped}
        onQueue={(next) => {
          setQueue(next);
          setPage(0);
          setReason('all');
          setSearch('');
        }}
        onReason={setReason}
        onSearch={setSearch}
      />
      <p className="mb-4 text-xs text-warning">{FLOW_BULK_RETRY_UNAVAILABLE}</p>

      {error && !data ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : discoveryLoading && !qs && !queue && !discoveryError ? (
        <LoadingState label="Discovering queues…" />
      ) : loading && !data && !error ? (
        <LoadingState label="Loading DLQ…" />
      ) : discoveryError && !queue ? (
        <EmptyState
          icon={<IconDlq />}
          title="Could not discover queues"
          hint={`${discoveryError.message}. Retry the queue discovery request above.`}
        />
      ) : !queue ? (
        <EmptyState
          icon={<IconDlq />}
          title={qs?.queues.length === 0 ? 'No queues available' : 'Select a queue'}
          hint="A queue must be selected before its dead letter entries can be inspected."
        />
      ) : entries.length === 0 ? (
        <EmptyState
          icon={<IconDlq />}
          title={filterActive ? 'No matches' : 'Dead letter queue is empty'}
          hint={
            filterActive
              ? pageScoped
                ? 'No entries on this page match your filter — filters are page-scoped. Try another page or clear them.'
                : 'No entries match your filter. Clear it to see all entries.'
              : 'Failed jobs that exhaust their retries land here.'
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-faint">
                <th className="w-8 py-3 pl-4" />
                <th className="px-3 py-3 font-medium">Name</th>
                <th className="px-3 py-3 font-medium">Job ID</th>
                <th className="px-3 py-3 font-medium">Reason</th>
                <th className="px-3 py-3 font-medium">Error</th>
                <th className="px-3 py-3 text-right font-medium">Attempts</th>
                <th className="px-3 py-3 text-right font-medium">Entered</th>
                <th className="w-20 px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => {
                const key = rowKey(e);
                const isOpen = expanded.has(key);
                const attempts = e.attempts ?? [];
                return (
                  <DlqRow
                    key={key}
                    entry={e}
                    isOpen={isOpen}
                    onToggle={() => toggleExpand(key)}
                    attempts={attempts}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {data && (
        <Pagination
          page={page}
          pageSize={PAGE_SIZE}
          total={data.total}
          onPageChange={setPage}
          label="entries"
        />
      )}
    </div>
  );
}
