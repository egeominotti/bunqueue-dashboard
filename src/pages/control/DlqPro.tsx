import { useCallback, useMemo, useState } from 'react';
import { Button, IconButton } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState, LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { Select } from '@/components/ui/form';
import { IconDlq, IconRefresh } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { bq } from '@/lib/bq';
import { cn } from '@/lib/cn';
import { formatNumber, formatRelativeTime } from '@/lib/format';
import { usePolledData } from '@/lib/usePolledData';

const PAGE_SIZE = 25;

export function DlqPro() {
  const [queue, setQueue] = useState('');
  const [reason, setReason] = useState('all');
  const [sort, setSort] = useState<'newest' | 'oldest'>('newest');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // One /dashboard/queues for the per-queue DLQ counts + grand total, plus — only
  // when a queue is selected — one paginated /dlq page and one /dlq/stats for
  // that queue. Previously this fanned out one /dlq/stats per DLQ-bearing queue
  // on every poll; now it's at most three requests regardless of queue count.
  const fetcher = useCallback(async () => {
    const qsr = await bq.queues();
    const total = qsr.queues.reduce((a, q) => a + q.dlq, 0);
    if (!queue) {
      return { queues: qsr.queues, total, entries: [], entriesTotal: 0, stats: null };
    }
    const [list, statsRes] = await Promise.all([
      bq.dlq(queue, PAGE_SIZE, page * PAGE_SIZE),
      bq.dlqStats(queue).catch(() => null),
    ]);
    return {
      queues: qsr.queues,
      total,
      entries: list.entries ?? [],
      entriesTotal: list.total ?? 0,
      stats: statsRes?.stats ?? null,
    };
  }, [queue, page]);
  const { data, error, loading, refetch } = usePolledData(fetcher, [queue, page]);

  const run = async (label: string, fn: () => Promise<{ count?: number }>) => {
    if (!window.confirm(`${label} for "${queue}"?`)) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await fn();
      setMsg(`${label}: ${r?.count ?? 'ok'}`);
      refetch();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const selectQueue = (name: string) => {
    setQueue(name);
    setPage(0);
    setReason('all');
  };

  const byReason = data?.stats?.byReason ?? {};
  const reasons = Object.keys(byReason).filter((r) => byReason[r] > 0);
  const topReason = [...reasons].sort((a, b) => (byReason[b] ?? 0) - (byReason[a] ?? 0))[0];

  // Grid shows only queues that actually have DLQ entries (the rest are noise),
  // sorted by DLQ size — a natural bound on the rendered list.
  const dlqQueues = useMemo(
    () => (data?.queues ?? []).filter((q) => q.dlq > 0).sort((a, b) => b.dlq - a.dlq),
    [data]
  );

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

  const healthy = (data?.total ?? 0) === 0;
  // Reason/search/sort act on the loaded page only. When the queue spans more than
  // one server page, say so on the sort control (search is already honestly labeled).
  const filterActive = reason !== 'all' || search.trim() !== '';
  const pageScoped = (data?.entriesTotal ?? 0) > PAGE_SIZE;

  return (
    <div>
      <PageHeader
        title="Dead Letter Queue"
        description="Jobs that failed after exhausting all retries. Monitor, retry, or purge."
        live
      />

      {error && <OfflineBanner onRetry={refetch} />}

      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        <Card>
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium uppercase tracking-wider text-faint">
              Total in DLQ
            </span>
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-[11px] font-medium',
                healthy ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'
              )}
            >
              {healthy ? 'Healthy' : 'Attention'}
            </span>
          </div>
          <div
            className={cn(
              'mt-2 text-3xl font-bold tnum',
              healthy ? 'text-emerald-400' : 'text-red-400'
            )}
          >
            {formatNumber(data?.total)}
          </div>
        </Card>
        <Card>
          <div className="text-[11px] font-medium uppercase tracking-wider text-faint">
            Top Reason
          </div>
          <div className="mt-2 text-lg font-semibold text-fg">
            {queue ? (topReason ?? 'No failures') : 'Select a queue'}
          </div>
        </Card>
        <Card>
          <div className="text-[11px] font-medium uppercase tracking-wider text-faint">
            Pending Retry
          </div>
          <div className="mt-2 text-3xl font-bold tnum text-fg">
            {data?.stats?.pendingRetry ? formatNumber(data.stats.pendingRetry) : '—'}
          </div>
          <div className="mt-1 text-xs text-faint">
            {queue ? 'in this queue' : 'awaiting retry'}
          </div>
        </Card>
        <Card>
          <div className="text-[11px] font-medium uppercase tracking-wider text-faint">
            Failure Types
          </div>
          <div className="mt-2 text-3xl font-bold tnum text-fg">{reasons.length || '—'}</div>
          <div className="mt-1 text-xs text-faint">distinct reasons</div>
        </Card>
      </div>

      {dlqQueues.length > 0 && (
        <Card className="mb-6">
          <div className="mb-3 text-[11px] font-medium uppercase tracking-wider text-faint">
            DLQ by queue
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-5">
            {dlqQueues.map((q) => (
              <button
                key={q.name}
                type="button"
                onClick={() => selectQueue(q.name)}
                className={cn(
                  'rounded-lg border p-3 text-left transition-colors',
                  queue === q.name
                    ? 'border-accent/50 bg-surface-2'
                    : 'border-line hover:border-line-strong'
                )}
              >
                <div className="truncate font-mono text-xs text-muted">{q.name}</div>
                <div className="mt-1 text-xl font-bold tnum text-red-400">{q.dlq}</div>
              </button>
            ))}
          </div>
        </Card>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="w-48">
          <Select value={queue} onChange={(e) => selectQueue(e.target.value)}>
            <option value="">Select a queue…</option>
            {(data?.queues ?? []).map((q) => (
              <option key={q.name} value={q.name}>
                {q.name}
                {q.dlq ? ` (${q.dlq})` : ''}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-40">
          <Select value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="all">All Reasons</option>
            {reasons.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-36">
          <Select
            value={sort}
            onChange={(e) => setSort(e.target.value as 'newest' | 'oldest')}
            aria-label={pageScoped ? 'Sort this page' : 'Sort'}
          >
            <option value="newest">Newest First{pageScoped ? ' (this page)' : ''}</option>
            <option value="oldest">Oldest First{pageScoped ? ' (this page)' : ''}</option>
          </Select>
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter this page by job ID…"
          className="h-9 min-w-40 flex-1 rounded-lg border border-line bg-surface px-3 text-sm text-fg placeholder:text-faint focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/30"
        />
        <Button
          size="sm"
          disabled={!queue || busy}
          onClick={() => run('Retry all', () => bq.retryDlq(queue))}
        >
          <IconRefresh className="size-3.5" /> Retry All
        </Button>
        <Button
          variant="danger"
          size="sm"
          disabled={!queue || busy}
          onClick={() => run('Purge all', () => bq.purgeDlq(queue))}
        >
          Purge All
        </Button>
      </div>
      {msg && <div className="mb-3 text-xs text-muted">{msg}</div>}

      {loading && !data && !error ? (
        <LoadingState label="Loading DLQ…" />
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
        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-faint">
                <th className="px-5 py-3 font-medium">Job ID</th>
                <th className="px-5 py-3 font-medium">Reason</th>
                <th className="px-5 py-3 font-medium">Error</th>
                <th className="px-5 py-3 text-right font-medium">Entered</th>
                <th className="w-16 px-5 py-3" />
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr
                  key={`${e.job.id}-${e.enteredAt}`}
                  className="border-b border-line last:border-0 align-top hover:bg-surface-2/40"
                >
                  <td className="px-5 py-3 font-mono text-xs text-muted">{e.job.id}</td>
                  <td className="px-5 py-3">
                    <span className="rounded-md bg-red-500/10 px-2 py-0.5 text-xs text-red-400">
                      {e.reason}
                    </span>
                  </td>
                  <td className="max-w-md px-5 py-3 text-xs text-red-400/80">{e.error || '—'}</td>
                  <td className="px-5 py-3 text-right text-faint">
                    {formatRelativeTime(e.enteredAt)}
                  </td>
                  <td className="px-5 py-3 text-right">
                    <IconButton
                      aria-label="Retry"
                      disabled={busy}
                      onClick={() => run('Retry', () => bq.retryDlq(queue, e.job.id))}
                    >
                      <IconRefresh className="size-3.5" />
                    </IconButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
