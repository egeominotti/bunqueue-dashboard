import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from '@/components/dashboard/stores/toastStore';
import { EmptyState, ErrorState, LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { IconDlq } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { bq } from '@/lib/bq';
import { downloadCsv } from '@/lib/exportFile';
import { FLOW_BULK_RETRY_UNAVAILABLE } from '@/lib/flowMutationSafety';
import type { QueueSummary } from '@/lib/types';
import { usePolledData } from '@/lib/usePolledData';
import { DlqFilters, DlqQueueGrid, DlqSummary } from './dlq/DlqProControls';
import { DlqProTable } from './dlq/DlqProTable';
import { loadAllQueuePages } from './QueueControl';

const PAGE_SIZE = 25;
const EMPTY_QUEUES: QueueSummary[] = [];

export function DlqPro() {
  const [params, setParams] = useSearchParams();
  const [queue, setQueue] = useState('');
  const [reason, setReason] = useState('all');
  const [sort, setSort] = useState<'newest' | 'oldest'>('newest');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [expandedErrors, setExpandedErrors] = useState<Set<string>>(new Set());

  // The queue list (per-queue DLQ counts + grand total + dropdown) changes
  // slowly, so poll it on its own slow cadence instead of on the fast DLQ poll.
  const {
    data: qs,
    error: discoveryError,
    loading: discoveryLoading,
    refetch: refetchQueues,
  } = usePolledData(loadAllQueuePages, [], { intervalMs: 10000 });
  const queues = qs?.queues ?? EMPTY_QUEUES;
  const total = qs ? queues.reduce((a, q) => a + q.dlq, 0) : null;

  // Fast poll: only the selected queue's paginated /dlq page + /dlq/stats.
  // Tagged with queue+page (QueueControl pattern): after a queue switch the old
  // queue's entries must not stay rendered under the new queue heading.
  const fetcher = useCallback(async () => {
    if (!queue)
      return {
        queue,
        page,
        entries: [],
        entriesTotal: 0,
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
      entriesTotal: list.total ?? 0,
      stats: statsResult.stats,
      statsError: statsResult.error,
    };
  }, [queue, page]);
  const { data: raw, error, loading, refetch } = usePolledData(fetcher, [queue, page]);
  const data = raw?.queue === queue && raw.page === page ? raw : null;

  // Clamp the page when the DLQ shrinks (retries/purges here or elsewhere) so a
  // stale offset can't render "empty" while entries remain.
  useEffect(() => {
    // Guard the transient null window: after a page/queue switch `data` is null
    // for one round-trip (the tag no longer matches the new selection). Without
    // this, `t` reads 0 and the clamp fires setPage(0) BEFORE the new page's
    // fetch resolves — snapping every "Next" click back to page 0 (forward
    // pagination becomes impossible). Only clamp against a real, matching total.
    if (!data) return;
    const t = data.entriesTotal ?? 0;
    if (page > 0 && page * PAGE_SIZE >= t) setPage(Math.max(0, Math.ceil(t / PAGE_SIZE) - 1));
  }, [data, page]);

  const exportEntries = () => {
    const rows = (data?.entries ?? []).map((e) => ({
      jobId: e.job.id,
      reason: e.reason,
      error: e.error ?? '',
      enteredAt: new Date(e.enteredAt).toISOString(),
      attempts: e.attempts?.length ?? 0,
    }));
    if (rows.length === 0) {
      toast.info('Nothing to export on this page');
      return;
    }
    downloadCsv(`dlq-${queue}`, rows, ['jobId', 'reason', 'error', 'enteredAt', 'attempts']);
  };

  const selectQueue = (name: string) => {
    // Any manual choice — including a reset to "Select a queue…" — disarms
    // the one-shot auto-pick below, so it can never override user intent
    // (even a reset made before the queue list first arrives).
    autoPicked.current = true;
    setQueue(name);
    setPage(0);
    setReason('all');
    // Keep the selection shareable/deep-linkable (replace: selection churn
    // must not pollute history).
    setParams(name ? { queue: name } : {}, { replace: true });
  };

  const byReason = data?.stats?.byReason ?? {};
  const reasons = Object.keys(byReason).filter((r) => byReason[r] > 0);
  const topReason = [...reasons].sort((a, b) => (byReason[b] ?? 0) - (byReason[a] ?? 0))[0];

  // Grid shows only queues that actually have DLQ entries (the rest are noise),
  // sorted by DLQ size — a natural bound on the rendered list.
  const dlqQueues = useMemo(
    () => queues.filter((q) => q.dlq > 0).sort((a, b) => b.dlq - a.dlq),
    [queues]
  );

  // First load: honor a ?queue= deep link (e.g. QueueDetailPro's DLQ jump-off),
  // else jump straight to the biggest non-empty DLQ instead of parking the user
  // on a "Select a queue" prompt (DlqControl already does this).
  // Once per mount, so a deliberate reset back to "Select a queue…" sticks.
  const autoPicked = useRef(false);
  const urlQueue = params.get('queue');
  useEffect(() => {
    if (autoPicked.current || queue) return;
    if (urlQueue) {
      if (queues.some((q) => q.name === urlQueue)) {
        autoPicked.current = true;
        setQueue(urlQueue);
        setPage(0);
        setReason('all');
        return;
      }
      // Unknown/stale ?queue=: wait for the queue list before falling back.
      if (queues.length === 0) return;
    }
    if (dlqQueues.length === 0) return;
    autoPicked.current = true;
    setQueue(dlqQueues[0].name);
    setPage(0);
    setReason('all');
  }, [queue, queues, dlqQueues, urlQueue]);

  // Reason/search filter the currently-loaded page (the server paginates but has
  // no reason/id filter). Sort within the page too.
  const entries = useMemo(() => {
    let list = data?.entries ?? [];
    if (reason !== 'all') list = list.filter((e) => e.reason === reason);
    const term = search.trim().toLowerCase();
    if (term) list = list.filter((e) => e.job.id.toLowerCase().includes(term));
    return [...list].sort((a, b) =>
      sort === 'newest' ? b.enteredAt - a.enteredAt : a.enteredAt - b.enteredAt
    );
  }, [data, reason, search, sort]);

  const healthy = total === 0 && !discoveryError;
  // Reason/search/sort act on the loaded page only. When the queue spans more than
  // one server page, say so on the sort control (search is already honestly labeled).
  const filterActive = reason !== 'all' || search.trim() !== '';
  const pageScoped = (data?.entriesTotal ?? 0) > PAGE_SIZE;

  return (
    <div>
      <PageHeader
        title="Dead Letter Queue"
        description="Jobs that failed after exhausting all retries. Inspect and export entries without mutating flow topology."
        live={!!queue && !!data && !data.statsError && !error && !discoveryError}
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
          message={`Could not discover queue DLQ totals — ${discoveryError.message}. Health status is unavailable.`}
        />
      )}
      {data?.statsError && (
        <OfflineBanner
          message={`DLQ statistics are unavailable — ${data.statsError}. The entry list may still be current.`}
          onRetry={refetch}
        />
      )}

      <DlqSummary
        total={total}
        discoveryError={!!discoveryError}
        healthy={healthy}
        statsError={!!data?.statsError}
        queue={queue}
        topReason={topReason}
        pendingRetry={data?.stats?.pendingRetry}
        reasonCount={data?.stats ? reasons.length : undefined}
      />
      <DlqQueueGrid queues={dlqQueues} queue={queue} onSelect={selectQueue} />
      <DlqFilters
        queue={queue}
        queues={queues}
        reason={reason}
        reasons={reasons}
        sort={sort}
        search={search}
        pageScoped={pageScoped}
        onQueue={selectQueue}
        onReason={setReason}
        onSort={setSort}
        onSearch={setSearch}
        onExport={exportEntries}
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
          title="Select a queue"
          hint="Choose a queue from the dropdown to view its dead letter queue entries."
        />
      ) : entries.length === 0 ? (
        <EmptyState
          icon={<IconDlq />}
          title={filterActive ? 'No matches on this page' : 'No dead letter entries'}
          hint={
            filterActive
              ? 'No entries on this page match your filter — the filter is page-scoped. Use the pager below to check other pages.'
              : 'This queue has no dead letter entries.'
          }
        />
      ) : (
        <DlqProTable
          entries={entries}
          expanded={expandedErrors}
          onToggle={(key) =>
            setExpandedErrors((current) => {
              const next = new Set(current);
              next.has(key) ? next.delete(key) : next.add(key);
              return next;
            })
          }
        />
      )}

      {queue && data && (
        <Pagination
          page={page}
          pageSize={PAGE_SIZE}
          total={data.entriesTotal}
          onPageChange={setPage}
          label="entries"
        />
      )}
    </div>
  );
}
