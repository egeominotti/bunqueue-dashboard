import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { EmptyState, LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { Select } from '@/components/ui/form';
import { IconDlq } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { StatCard } from '@/components/ui/StatCard';
import { api } from '@/lib/api';
import { formatNumber, formatRelativeTime } from '@/lib/format';
import type { DlqEntry } from '@/lib/types';
import { usePolledData } from '@/lib/usePolledData';

const PAGE_SIZE = 25;

export function Dlq() {
  const [queue, setQueue] = useState<string>('');
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const { data: qs } = usePolledData(() => api.queues(500), [], { intervalMs: 30000 });

  // Default the selected queue to the first one that has DLQ entries.
  useEffect(() => {
    if (queue || !qs?.queues?.length) return;
    const withDlq = qs.queues.find((q) => q.dlq > 0) ?? qs.queues[0];
    setQueue(withDlq.name);
  }, [qs, queue]);

  const fetcher = useCallback(async () => {
    if (!queue) return { entries: [] as DlqEntry[], total: 0 };
    const res = await api.dlq(queue, PAGE_SIZE, page * PAGE_SIZE);
    return { entries: res.entries ?? [], total: res.total ?? res.entries?.length ?? 0 };
  }, [queue, page]);
  const { data, error, loading, refetch } = usePolledData(fetcher, [queue, page]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    if (!window.confirm(`${label} the dead letter queue for "${queue}"?`)) return;
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg(`${label} done`);
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
      {error && <OfflineBanner onRetry={refetch} />}
      <PageHeader
        title="Dead Letter Queue"
        description="Jobs that exhausted their retries."
        live
        actions={
          <>
            <Button
              size="sm"
              disabled={!queue || busy}
              onClick={() => run('Retry', () => api.retryDlq(queue))}
            >
              Retry all
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={!queue || busy}
              onClick={() => run('Purge', () => api.purgeDlq(queue))}
            >
              Purge
            </Button>
          </>
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <div className="w-56">
          <Select
            value={queue}
            onChange={(e) => {
              setQueue(e.target.value);
              setPage(0);
            }}
          >
            {(qs?.queues ?? []).map((q) => (
              <option key={q.name} value={q.name}>
                {q.name} {q.dlq ? `(${q.dlq})` : ''}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-40">
          <StatCard
            label="DLQ Entries"
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
          hint="Jobs land here after exhausting their retry attempts."
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-faint">
                <th className="px-5 py-3 font-medium">Job ID</th>
                <th className="px-5 py-3 font-medium">Name</th>
                <th className="px-5 py-3 font-medium">Reason</th>
                <th className="px-5 py-3 text-right font-medium">Attempts</th>
                <th className="px-5 py-3 text-right font-medium">Failed</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e, i) => (
                <tr
                  key={e.job.id || i}
                  className="border-b border-line last:border-0 align-top hover:bg-surface-2/40"
                >
                  <td className="px-5 py-3 font-mono text-xs text-muted">{e.job.id}</td>
                  <td className="px-5 py-3 text-fg">
                    {(e.job.data as { name?: string } | undefined)?.name || 'unnamed'}
                  </td>
                  <td className="max-w-md px-5 py-3 text-xs text-red-400/90">
                    {String(e.reason || e.error || '—')}
                  </td>
                  <td className="px-5 py-3 text-right tnum text-muted">
                    {e.attempts?.length ?? e.job.attempts ?? '—'}
                  </td>
                  <td className="px-5 py-3 text-right text-faint">
                    {formatRelativeTime(e.attempts?.at(-1)?.failedAt ?? e.enteredAt)}
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
