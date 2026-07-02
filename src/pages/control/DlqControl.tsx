import { useCallback, useEffect, useState } from 'react';
import { Button, IconButton } from '@/components/ui/Button';
import { EmptyState, LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { Select } from '@/components/ui/form';
import { IconDlq, IconRefresh } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { StatCard } from '@/components/ui/StatCard';
import { bq } from '@/lib/bq';
import type { DlqEntryFull } from '@/lib/bqTypes';
import { formatNumber, formatRelativeTime } from '@/lib/format';
import { usePolledData } from '@/lib/usePolledData';

const PAGE_SIZE = 25;

export function DlqControl() {
  const [queue, setQueue] = useState('');
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const { data: qs } = usePolledData(() => bq.queues(), [], { intervalMs: 30000 });

  useEffect(() => {
    if (queue || !qs?.queues?.length) return;
    setQueue((qs.queues.find((x) => x.dlq > 0) ?? qs.queues[0]).name);
  }, [qs, queue]);

  const fetcher = useCallback(async () => {
    if (!queue) return { entries: [] as DlqEntryFull[], total: 0 };
    const list = await bq.dlq(queue, PAGE_SIZE, page * PAGE_SIZE);
    return { entries: list.entries ?? [], total: list.total ?? 0 };
  }, [queue, page]);
  const { data, error, loading, refetch } = usePolledData(fetcher, [queue, page]);

  // Clamp the page when the DLQ shrinks (retry-all/purge here, or external
  // retries) so a stale offset can't render "empty" while entries remain.
  useEffect(() => {
    if (!data) return;
    const last = Math.max(0, Math.ceil((data.total ?? 0) / PAGE_SIZE) - 1);
    if (page > last) setPage(last);
  }, [data, page]);

  const run = async (label: string, fn: () => Promise<unknown>, confirmMsg?: string) => {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = (await fn()) as { count?: number };
      setMsg(`${label}: ${r?.count ?? 'ok'}`);
      refetch();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const entries = data?.entries ?? [];

  return (
    <div>
      <PageHeader
        title="Dead Letter Queue"
        description="Inspect and replay jobs that exhausted their retries."
        live
        actions={
          <>
            <Button
              size="sm"
              disabled={!queue || busy}
              onClick={() => run('Retried', () => bq.retryDlq(queue))}
            >
              <IconRefresh className="size-3.5" /> Retry all
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={!queue || busy}
              onClick={() =>
                run('Purged', () => bq.purgeDlq(queue), `Purge the DLQ for "${queue}"?`)
              }
            >
              Purge
            </Button>
          </>
        }
      />

      {error && <OfflineBanner onRetry={refetch} />}

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <div className="w-56">
          <Select
            value={queue}
            onChange={(e) => {
              setQueue(e.target.value);
              setPage(0);
            }}
          >
            {(qs?.queues ?? []).map((x) => (
              <option key={x.name} value={x.name}>
                {x.name} {x.dlq ? `(${x.dlq})` : ''}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-40">
          <StatCard
            label="Entries"
            value={formatNumber(data?.total)}
            tone={data?.total ? 'red' : 'default'}
            compact
          />
        </div>
        {msg && <span className="text-xs text-muted">{msg}</span>}
      </div>

      {loading && !data && !error ? (
        <LoadingState label="Loading DLQ…" />
      ) : entries.length === 0 ? (
        <EmptyState
          icon={<IconDlq />}
          title="Dead letter queue is empty"
          hint="Failed jobs that exhaust their retries land here."
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-faint">
                <th className="px-5 py-3 font-medium">Job ID</th>
                <th className="px-5 py-3 font-medium">Reason</th>
                <th className="px-5 py-3 font-medium">Error</th>
                <th className="px-5 py-3 text-right font-medium">Attempts</th>
                <th className="px-5 py-3 text-right font-medium">Entered</th>
                <th className="w-20 px-5 py-3" />
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
                  <td className="px-5 py-3 text-right tnum text-muted">
                    {e.job.attempts ?? e.attempts?.length ?? '—'}
                  </td>
                  <td className="px-5 py-3 text-right text-faint">
                    {formatRelativeTime(e.enteredAt)}
                  </td>
                  <td className="px-5 py-3 text-right">
                    <IconButton
                      aria-label="Retry job"
                      disabled={busy}
                      onClick={() => run('Retried', () => bq.retryDlq(queue, e.job.id))}
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
