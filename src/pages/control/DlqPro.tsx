import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { toast } from '@/components/dashboard/stores/toastStore';
import { Button, IconButton } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState, LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { Select } from '@/components/ui/form';
import { IconDlq, IconDownload, IconRefresh } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { bq } from '@/lib/bq';
import { cn } from '@/lib/cn';
import { downloadCsv } from '@/lib/exportFile';
import { formatNumber, formatRelativeTime } from '@/lib/format';
import { settledPool } from '@/lib/promisePool';
import { usePolledData } from '@/lib/usePolledData';

const FANOUT_LIMIT = 6;

const PAGE_SIZE = 25;

export function DlqPro() {
  const [params, setParams] = useSearchParams();
  const [queue, setQueue] = useState('');
  const [reason, setReason] = useState('all');
  const [sort, setSort] = useState<'newest' | 'oldest'>('newest');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [expandedErrors, setExpandedErrors] = useState<Set<string>>(new Set());

  // The queue list (per-queue DLQ counts + grand total + dropdown) changes
  // slowly, so poll it on its own slow cadence instead of on the fast DLQ poll.
  const { data: qs, refetch: refetchQueues } = usePolledData(() => bq.queues(), [], {
    intervalMs: 10000,
  });
  const queues = qs?.queues ?? [];
  const total = queues.reduce((a, q) => a + q.dlq, 0);

  // Fast poll: only the selected queue's paginated /dlq page + /dlq/stats.
  // Tagged with queue+page (QueueControl pattern): after a queue switch the old
  // queue's entries must not stay rendered — their per-row Retry would fire
  // bq.retryDlq(newQueue, oldEntry.job.id), an action against the wrong entity.
  const fetcher = useCallback(async () => {
    if (!queue) return { queue, page, entries: [], entriesTotal: 0, stats: null };
    const [list, statsRes] = await Promise.all([
      bq.dlq(queue, PAGE_SIZE, page * PAGE_SIZE),
      bq.dlqStats(queue).catch(() => null),
    ]);
    return {
      queue,
      page,
      entries: list.entries ?? [],
      entriesTotal: list.total ?? 0,
      stats: statsRes?.stats ?? null,
    };
  }, [queue, page]);
  const { data: raw, error, loading, refetch } = usePolledData(fetcher, [queue, page]);
  const data = raw && raw.queue === queue && raw.page === page ? raw : null;

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

  const run = async (confirmText: string, verb: string, fn: () => Promise<{ count?: number }>) => {
    if (!window.confirm(confirmText)) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await fn();
      const n = r?.count ?? 0;
      const text = `${verb} ${formatNumber(n)} ${n === 1 ? 'entry' : 'entries'}`;
      setMsg({ ok: true, text });
      toast.success(text);
      // Refresh the selected queue's page AND the queue list (grand total /
      // "DLQ by queue" grid / dropdown counts) after a retry or purge.
      refetch();
      refetchQueues();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
      toast.error(`${verb} failed`, (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Fan a retry/purge out over EVERY queue that currently has DLQ entries — the
  // incident-recovery action (a downstream outage fails jobs across many queues
  // at once). Tolerates per-queue failures via allSettled.
  const runAcross = async (verb: 'Retry' | 'Purge') => {
    const names = dlqQueues.map((x) => x.name);
    if (names.length === 0) return;
    if (
      !window.confirm(
        `${verb} the dead letter queue across ${names.length} queue(s) (${formatNumber(total)} entries)?`
      )
    )
      return;
    setBusy(true);
    setMsg(null);
    const results = await settledPool(names, FANOUT_LIMIT, (n) =>
      verb === 'Retry' ? bq.retryDlq(n) : bq.purgeDlq(n)
    );
    let count = 0;
    let failures = 0;
    for (const r of results) {
      if (r.status === 'fulfilled') count += r.value?.count ?? 0;
      else failures++;
    }
    const done = verb === 'Retry' ? 'Retried' : 'Purged';
    const text = `${done} ${formatNumber(count)} across ${names.length - failures}/${names.length} queues${
      failures ? `, ${failures} failed` : ''
    }`;
    setMsg({ ok: failures === 0, text });
    if (failures === 0) toast.success(text);
    else toast.error(text);
    refetch();
    refetchQueues();
    setBusy(false);
  };

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

  const healthy = total === 0;
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
                healthy ? 'bg-emerald-500/10 text-success' : 'bg-red-500/10 text-danger'
              )}
            >
              {healthy ? 'Healthy' : 'Attention'}
            </span>
          </div>
          <div
            className={cn('mt-2 text-3xl font-bold tnum', healthy ? 'text-success' : 'text-danger')}
          >
            {formatNumber(total)}
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
            {data?.stats ? formatNumber(data.stats.pendingRetry ?? 0) : '—'}
          </div>
          <div className="mt-1 text-xs text-faint">
            {queue ? 'in this queue' : 'awaiting retry'}
          </div>
        </Card>
        <Card>
          <div className="text-[11px] font-medium uppercase tracking-wider text-faint">
            Failure Types
          </div>
          <div className="mt-2 text-3xl font-bold tnum text-fg">
            {data?.stats ? formatNumber(reasons.length) : '—'}
          </div>
          <div className="mt-1 text-xs text-faint">distinct reasons</div>
        </Card>
      </div>

      {dlqQueues.length > 0 && (
        <Card className="mb-6">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11px] font-medium uppercase tracking-wider text-faint">
              DLQ by queue
            </span>
            <div className="flex items-center gap-2">
              <Button size="sm" disabled={busy} onClick={() => runAcross('Retry')}>
                <IconRefresh className="size-3.5" /> Retry all ({dlqQueues.length} queues)
              </Button>
              <Button variant="danger" size="sm" disabled={busy} onClick={() => runAcross('Purge')}>
                Purge all ({dlqQueues.length} queues)
              </Button>
            </div>
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
                <div className="mt-1 text-xl font-bold tnum text-danger">{q.dlq}</div>
              </button>
            ))}
          </div>
        </Card>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="w-48">
          <Select value={queue} onChange={(e) => selectQueue(e.target.value)}>
            <option value="">Select a queue…</option>
            {queues.map((q) => (
              <option key={q.name} value={q.name}>
                {q.name}
                {q.dlq ? ` (${q.dlq})` : ''}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-40">
          <Select
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            aria-label="Filter by reason"
          >
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
          aria-label="Filter this page by job ID"
          className="h-9 min-w-40 flex-1 rounded-lg border border-line bg-surface px-3 text-sm text-fg placeholder:text-faint focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/30"
        />
        <Button
          size="sm"
          disabled={!queue || busy}
          onClick={() => run(`Retry all for "${queue}"?`, 'Retried', () => bq.retryDlq(queue))}
        >
          <IconRefresh className="size-3.5" /> Retry All
        </Button>
        <Button
          variant="danger"
          size="sm"
          disabled={!queue || busy}
          onClick={() => run(`Purge all for "${queue}"?`, 'Purged', () => bq.purgeDlq(queue))}
        >
          Purge All
        </Button>
        <IconButton
          aria-label="Export this page to CSV"
          title="Export this page to CSV"
          disabled={!queue}
          onClick={exportEntries}
        >
          <IconDownload className="size-3.5" />
        </IconButton>
      </div>
      {msg && (
        <div role="status" className={cn('mb-3 text-sm', msg.ok ? 'text-success' : 'text-danger')}>
          {msg.text}
        </div>
      )}

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
                <th scope="col" className="px-5 py-3 font-medium">
                  Job ID
                </th>
                <th scope="col" className="px-5 py-3 font-medium">
                  Reason
                </th>
                <th scope="col" className="px-5 py-3 font-medium">
                  Error
                </th>
                <th scope="col" className="px-5 py-3 text-right font-medium">
                  Entered
                </th>
                <th scope="col" className="w-16 px-5 py-3" />
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr
                  key={`${e.job.id}-${e.enteredAt}`}
                  className="border-b border-line last:border-0 align-top hover:bg-surface-2/40"
                >
                  <td className="px-5 py-3">
                    <Link
                      to={`/job?id=${encodeURIComponent(e.job.id)}`}
                      className="font-mono text-xs text-accent hover:underline"
                    >
                      {e.job.id}
                    </Link>
                  </td>
                  <td className="px-5 py-3">
                    <span className="rounded-md bg-red-500/10 px-2 py-0.5 text-xs text-danger">
                      {e.reason}
                    </span>
                  </td>
                  <td className="max-w-md px-5 py-3 text-xs text-danger/80">
                    {e.error ? (
                      // Long errors collapse to two lines; click (or hover for
                      // the title tooltip) reveals the full text in place.
                      <button
                        type="button"
                        title={e.error}
                        onClick={() =>
                          setExpandedErrors((s) => {
                            const n = new Set(s);
                            const k = `${e.job.id}-${e.enteredAt}`;
                            n.has(k) ? n.delete(k) : n.add(k);
                            return n;
                          })
                        }
                        className={cn(
                          'block w-full break-words text-left',
                          !expandedErrors.has(`${e.job.id}-${e.enteredAt}`) && 'line-clamp-2'
                        )}
                      >
                        {e.error}
                      </button>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-5 py-3 text-right text-faint">
                    {formatRelativeTime(e.enteredAt)}
                  </td>
                  <td className="px-5 py-3 text-right">
                    <IconButton
                      aria-label="Retry"
                      disabled={busy}
                      onClick={() =>
                        run(`Retry job ${e.job.id.slice(0, 8)}… from "${queue}"?`, 'Retried', () =>
                          bq.retryDlq(queue, e.job.id)
                        )
                      }
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
