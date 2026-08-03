import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { EmptyState, ErrorState, LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { Select } from '@/components/ui/form';
import { IconDlq } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { StatCard } from '@/components/ui/StatCard';
import { api } from '@/lib/api';
import { FLOW_BULK_RETRY_UNAVAILABLE, FLOW_DELETION_UNAVAILABLE } from '@/lib/flowMutationSafety';
import { formatNumber, formatRelativeTime } from '@/lib/format';
import type { DlqEntry } from '@/lib/types';
import { usePolledData } from '@/lib/usePolledData';
import { discoverAllQueues } from './Jobs';

const PAGE_SIZE = 25;

function validQueueCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

// Classic pages share the same bounded, strict pagination walk as Jobs. DLQ
// additionally consumes the summary counters, so validate every merged row
// before publishing anything to the selector/default-selection effect.
export async function discoverAllDlqQueues() {
  const result = await discoverAllQueues();
  if (
    !Number.isFinite(result.timestamp) ||
    result.queues.some(
      (entry) =>
        !validQueueCount(entry.waiting) ||
        !validQueueCount(entry.delayed) ||
        !validQueueCount(entry.active) ||
        !validQueueCount(entry.dlq) ||
        typeof entry.paused !== 'boolean'
    )
  ) {
    throw new Error('Queue discovery returned malformed queue summaries');
  }
  return result;
}

export function Dlq() {
  const [queue, setQueue] = useState<string>('');
  const [page, setPage] = useState(0);

  const {
    data: qs,
    error: discoveryError,
    loading: discoveryLoading,
    refetch: refetchQueues,
  } = usePolledData(discoverAllDlqQueues, [], { intervalMs: 30000 });

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

  const entries = data?.entries ?? [];

  return (
    <div>
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
      <PageHeader
        title="Dead Letter Queue"
        description="Jobs that exhausted their retries."
        live={!!queue && !!data && !error && !discoveryError}
        actions={
          <>
            <Button size="sm" disabled title={FLOW_BULK_RETRY_UNAVAILABLE}>
              Retry all
            </Button>
            <Button variant="danger" size="sm" disabled title={FLOW_DELETION_UNAVAILABLE}>
              Purge
            </Button>
          </>
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <div className="w-56">
          <Select
            value={queue}
            aria-label="Queue"
            name="classic-dlq-queue"
            autoComplete="off"
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
            value={queue && data ? formatNumber(data.total) : '—'}
            tone={queue && data?.total ? 'red' : 'default'}
            compact
          />
        </div>
      </div>

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
