import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from '@/components/dashboard/stores/toastStore';
import { Button, IconButton } from '@/components/ui/Button';
import { CopyButton } from '@/components/ui/CopyButton';
import { EmptyState, ErrorState, LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { Select } from '@/components/ui/form';
import {
  IconChevronRight,
  IconDlq,
  IconDownload,
  IconEye,
  IconRefresh,
  IconSearch,
} from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { StatCard } from '@/components/ui/StatCard';
import { bq } from '@/lib/bq';
import type { DlqEntryFull } from '@/lib/bqTypes';
import { cn } from '@/lib/cn';
import { downloadCsv } from '@/lib/exportFile';
import { FLOW_BULK_RETRY_UNAVAILABLE, FLOW_DELETION_UNAVAILABLE } from '@/lib/flowMutationSafety';
import { formatDateTime, formatDuration, formatNumber, formatRelativeTime } from '@/lib/format';
import { usePolledData } from '@/lib/usePolledData';
import { loadAllQueuePages } from './QueueControl';

const PAGE_SIZE = 25;

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
  const data = raw && raw.queue === queue && raw.page === page ? raw : null;

  // Clamp the page when the DLQ shrinks externally so a stale offset cannot
  // render "empty" while entries remain.
  useEffect(() => {
    if (!data) return;
    const last = Math.max(0, Math.ceil((data.total ?? 0) / PAGE_SIZE) - 1);
    if (page > last) setPage(last);
  }, [data, page]);

  // Selecting a different queue/page shows different rows — drop any expanded
  // detail panels so they can't render against rows that no longer exist.
  // biome-ignore lint/correctness/useExhaustiveDependencies: collapse on view change
  useEffect(() => {
    setExpanded(new Set());
  }, [queue, page]);

  const byReason = data?.stats?.byReason ?? {};
  const reasons = useMemo(() => Object.keys(byReason).filter((r) => byReason[r] > 0), [byReason]);
  const topReason = useMemo(
    () => [...reasons].sort((a, b) => (byReason[b] ?? 0) - (byReason[a] ?? 0))[0],
    [reasons, byReason]
  );

  const allEntries = data?.entries ?? [];
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

      {/* At-a-glance triage summary for the selected queue. */}
      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard
          label="Entries"
          value={queue && data ? formatNumber(data.total) : '—'}
          tone={!queue || !data ? 'default' : data.total ? 'red' : 'green'}
          hint={
            !queue || !data
              ? 'waiting for queue data'
              : data.total
                ? topReason
                  ? `top: ${topReason}`
                  : undefined
                : 'queue is clean'
          }
          compact
        />
        <StatCard
          label="Failure types"
          value={data?.stats ? formatNumber(reasons.length) : '—'}
          hint="distinct reasons"
          compact
        />
        <StatCard
          label="Pending retry"
          value={data?.stats ? formatNumber(data.stats.pendingRetry ?? 0) : '—'}
          tone={data?.stats?.pendingRetry ? 'amber' : 'default'}
          hint="auto-retry queued"
          compact
        />
        <StatCard
          label="Oldest entry"
          value={data?.stats?.oldestEntry ? formatRelativeTime(data.stats.oldestEntry) : '—'}
          hint="time in DLQ"
          compact
        />
      </div>

      {/* Toolbar: queue picker + page-scoped reason/id filters. */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="w-56">
          <Select
            value={queue}
            aria-label="Queue"
            name="dlq-control-queue"
            autoComplete="off"
            onChange={(e) => {
              setQueue(e.target.value);
              setPage(0);
              setReason('all');
              // Drop cross-queue filter text so it cannot describe the previous queue.
              setSearch('');
            }}
          >
            {(qs?.queues ?? []).map((x) => (
              <option key={x.name} value={x.name}>
                {x.name} {x.dlq ? `(${x.dlq})` : ''}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-44">
          <Select
            value={reason}
            aria-label="Filter by reason"
            name="dlq-control-reason"
            autoComplete="off"
            onChange={(e) => setReason(e.target.value)}
          >
            <option value="all">All reasons</option>
            {reasons.map((r) => (
              <option key={r} value={r}>
                {r} ({byReason[r]})
              </option>
            ))}
          </Select>
        </div>
        <div className="relative min-w-40 flex-1">
          <IconSearch className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={pageScoped ? 'Filter this page by job ID…' : 'Filter by job ID…'}
            aria-label="Filter by job ID"
            name="dlq-control-job-filter"
            autoComplete="off"
            className="h-9 w-full rounded-lg border border-line bg-surface pl-9 pr-3 text-sm text-fg placeholder:text-faint focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
        </div>
      </div>
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

function DlqRow({
  entry,
  isOpen,
  onToggle,
  attempts,
}: {
  entry: DlqEntryFull;
  isOpen: boolean;
  onToggle: () => void;
  attempts: NonNullable<DlqEntryFull['attempts']>;
}) {
  const e = entry;
  return (
    <>
      <tr className="border-b border-line align-top last:border-0 hover:bg-surface-2/40">
        <td className="py-3 pl-4">
          <IconButton
            aria-label={isOpen ? 'Collapse details' : 'Expand details'}
            aria-expanded={isOpen}
            onClick={onToggle}
          >
            <IconChevronRight
              className={cn('size-3.5 transition-transform', isOpen && 'rotate-90')}
            />
          </IconButton>
        </td>
        <td className="px-3 py-3 font-mono text-xs text-muted">{e.job.name ?? 'default'}</td>
        <td className="px-3 py-3">
          <div className="flex items-center gap-1">
            <Link
              to={`/job?id=${encodeURIComponent(e.job.id)}`}
              className="max-w-[14rem] truncate font-mono text-xs text-accent hover:underline"
              title={e.job.id}
            >
              {e.job.id}
            </Link>
            <CopyButton value={e.job.id} />
          </div>
        </td>
        <td className="px-3 py-3">
          <span className="inline-block rounded-md bg-red-500/10 px-2 py-0.5 text-xs text-danger">
            {e.reason}
          </span>
        </td>
        <td className="px-3 py-3">
          <span className="block max-w-md truncate text-xs text-danger/80" title={e.error ?? ''}>
            {e.error || '—'}
          </span>
        </td>
        <td className="px-3 py-3 text-right tnum text-muted">
          {e.job.attempts ?? attempts.length}
        </td>
        <td className="px-3 py-3 text-right text-faint" title={formatDateTime(e.enteredAt)}>
          {formatRelativeTime(e.enteredAt)}
        </td>
        <td className="px-4 py-3">
          <div className="flex items-center justify-end gap-1">
            <Link
              to={`/job?id=${encodeURIComponent(e.job.id)}`}
              aria-label={`Inspect job ${e.job.id}`}
              className="inline-flex size-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
            >
              <IconEye className="size-3.5" />
            </Link>
            <IconButton
              aria-label="Retry job unavailable"
              disabled
              title={FLOW_BULK_RETRY_UNAVAILABLE}
            >
              <IconRefresh className="size-3.5" />
            </IconButton>
          </div>
        </td>
      </tr>
      {isOpen && (
        <tr className="border-b border-line bg-surface-2/30 last:border-0">
          <td />
          <td colSpan={7} className="px-3 pb-4 pt-1">
            {e.error && (
              <div className="mb-3">
                <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-faint">
                  Error
                </div>
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-surface p-3 font-mono text-xs text-danger/90">
                  {e.error}
                </pre>
              </div>
            )}
            <div className="mb-1 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-faint">
              Failure history
              {typeof e.retryCount === 'number' && e.retryCount > 0 && (
                <span className="rounded-full bg-surface px-2 py-0.5 text-[10px] normal-case text-muted">
                  retried {e.retryCount}×
                </span>
              )}
            </div>
            {attempts.length === 0 ? (
              <p className="text-xs text-faint">No per-attempt history recorded.</p>
            ) : (
              <ol className="space-y-1.5">
                {attempts.map((a) => (
                  <li
                    key={`${a.attempt}-${a.failedAt}`}
                    className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded-lg border border-line bg-surface px-3 py-2 text-xs"
                  >
                    <span className="font-medium text-fg">Attempt {a.attempt}</span>
                    <span className="text-faint" title={formatDateTime(a.failedAt)}>
                      {formatRelativeTime(a.failedAt)}
                    </span>
                    {a.duration != null && (
                      <span className="tnum text-muted">{formatDuration(a.duration)}</span>
                    )}
                    {a.reason && (
                      <span className="rounded bg-red-500/10 px-1.5 text-danger">{a.reason}</span>
                    )}
                    {a.error && <span className="w-full truncate text-danger/70">{a.error}</span>}
                  </li>
                ))}
              </ol>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
