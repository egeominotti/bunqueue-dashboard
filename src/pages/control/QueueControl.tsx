import { useCallback, useEffect, useState } from 'react';
import { ErrorState, LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { Select } from '@/components/ui/form';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatCard } from '@/components/ui/StatCard';
import { StatusDot } from '@/components/ui/StatusBadge';
import { QueueOperationsPanel } from '@/features/queue-operations/ui/QueueOperationsPanel';
import { bq } from '@/lib/bq';
import { formatNumber } from '@/lib/format';
import { usePolledData } from '@/lib/usePolledData';
import { useServerActionGuard } from '@/lib/useServerActionGuard';
import { ConfigLoadError, DlqConfigForm, StallForm } from './queue/ConfigForms';
import { LifecycleCard, LimitsCards } from './queue/QueueActions';
import {
  actionResultCount,
  assertQueueDetail,
  COUNT_KEYS,
  loadAllQueuePages,
  readDlqConfig,
  readStallConfig,
  resolveQueueSelection,
} from './queue/queueDiscovery';

export {
  actionResultCount,
  loadAllQueuePages,
  resolveQueueSelection,
} from './queue/queueDiscovery';

export function QueueControl() {
  const [queue, setQueue] = useState('');
  const [busy, setBusy] = useState(false);
  const [operationsRevision, setOperationsRevision] = useState(0);
  const [msg, setMsg] = useState<{ queue: string; ok: boolean; text: string } | null>(null);
  const actionGuard = useServerActionGuard(`queue-control:${queue}`);
  // scopeKey is the queue and connection lifecycle boundary.
  useEffect(() => {
    setBusy(false);
    setMsg(null);
  }, [actionGuard.scopeKey]);

  // Queue picker only — the queue set changes rarely, so poll it slowly instead
  // of on the fast global cadence (the live per-queue data has its own poll below).
  const {
    data: qs,
    error: discoveryError,
    loading: discoveryLoading,
    refetch: refetchQueues,
  } = usePolledData(loadAllQueuePages, [], { intervalMs: 30000 });
  useEffect(() => {
    if (!qs) return;
    setQueue((selected) => resolveQueueSelection(selected, qs.queues));
  }, [qs]);

  const fetcher = useCallback(async () => {
    if (!queue) return null;
    const [detail, stall, dlq] = await Promise.all([
      bq.queueDetail(queue, false),
      bq
        .getStallConfig(queue)
        .then(readStallConfig)
        .catch(() => null),
      bq
        .getDlqConfig(queue)
        .then(readDlqConfig)
        .catch(() => null),
    ]);
    assertQueueDetail(detail, queue);
    // Tagged with the queue it was fetched for, so a queue switch can't render
    // (or worse, save) queue A's config under queue B's name for one round-trip.
    return { queue, detail, stall, dlq };
  }, [queue]);
  const { data: raw, error, loading, refetch } = usePolledData(fetcher, [queue]);
  const queueIsDiscovered = !qs || qs.queues.some((entry) => entry.name === queue);
  const data = raw?.queue === queue && queueIsDiscovered ? raw : null;

  const run = (
    label: string,
    fn: () => Promise<unknown>,
    confirmMsg?: string,
    onSuccess?: () => void
  ) => {
    const targetQueue = queue;
    if (!targetQueue) return;
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    const lease = actionGuard.begin('queue-write');
    if (!lease) return;
    setBusy(true);
    setMsg(null);
    void (async () => {
      try {
        const summary = await bq.queuesSummary();
        if (!lease.isCurrent()) return;
        if (!summary.some((candidate) => candidate.name === targetQueue)) {
          throw new Error(`Queue "${targetQueue}" no longer exists`);
        }
        const count = actionResultCount(await fn());
        if (!lease.isCurrent()) return;
        setMsg({
          queue: targetQueue,
          ok: true,
          text: `${label}${count != null ? `: ${count}` : ' ✓'}`,
        });
        onSuccess?.();
        setOperationsRevision((revision) => revision + 1);
        await refetch();
      } catch (e) {
        if (lease.isCurrent()) {
          setMsg({ queue: targetQueue, ok: false, text: (e as Error).message });
        }
      } finally {
        if (lease.finish()) setBusy(false);
      }
    })();
  };

  return (
    <div>
      <PageHeader
        title="Queue Control"
        description="Full per-queue operations and configuration."
        live={!!queue && !!data?.detail && !!data.stall && !!data.dlq && !error && !discoveryError}
      />

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <div className="w-56">
          <Select
            value={queue}
            aria-label="Queue"
            name="queue-control-queue"
            autoComplete="off"
            onChange={(e) => setQueue(e.target.value)}
          >
            {(qs?.queues ?? []).map((x) => (
              <option key={x.name} value={x.name}>
                {x.name}
              </option>
            ))}
          </Select>
        </div>
        {data?.detail && (
          <StatusDot
            label={data.detail.paused ? 'Paused' : 'Active'}
            tone={data.detail.paused ? 'amber' : 'green'}
          />
        )}
        {msg?.queue === queue && (
          <span role="status" className={msg.ok ? 'text-xs text-success' : 'text-xs text-danger'}>
            {msg.text}
          </span>
        )}
      </div>

      {discoveryError && (
        <OfflineBanner
          onRetry={refetchQueues}
          message={`Could not discover queues — ${discoveryError.message}. Retry to choose a queue.`}
        />
      )}

      {error && data && (
        <OfflineBanner
          message="Queue refresh failed — showing the last successful configuration."
          onRetry={refetch}
        />
      )}

      {error && !data ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : discoveryLoading && !qs && !queue && !discoveryError ? (
        <LoadingState label="Discovering queues…" />
      ) : loading && !data ? (
        <LoadingState />
      ) : discoveryError && !queue ? (
        <p role="alert" className="text-sm text-warning">
          Queue discovery failed. Retry the request above before choosing a queue.
        </p>
      ) : !data?.detail ? (
        !error && (
          <p className="text-sm text-faint">
            {qs?.queues.length === 0 ? 'No queues are available.' : 'Select a queue.'}
          </p>
        )
      ) : (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
            {COUNT_KEYS.map((k) => (
              <StatCard key={k} label={k} value={formatNumber(data.detail.counts[k])} compact />
            ))}
          </div>

          <LifecycleCard
            key={`${queue}:lifecycle`}
            queue={queue}
            paused={data.detail.paused}
            busy={busy}
            run={run}
          />
          <LimitsCards key={`${queue}:limits`} queue={queue} busy={busy} run={run} />
          <QueueOperationsPanel
            key={`${actionGuard.scopeKey}:${queue}:sdk-operations`}
            queue={queue}
            refreshKey={operationsRevision}
            onApplied={() => setOperationsRevision((revision) => revision + 1)}
          />

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            {data.stall ? (
              <StallForm
                key={`${queue}:stall`}
                queue={queue}
                config={data.stall}
                onSaved={async () => {
                  setMsg({ queue, ok: true, text: 'Stall config saved ✓' });
                  await refetch();
                }}
              />
            ) : (
              <ConfigLoadError title="Stall detection" onRetry={refetch} />
            )}
            {data.dlq ? (
              <DlqConfigForm
                key={`${queue}:dlq`}
                queue={queue}
                config={data.dlq}
                onSaved={async () => {
                  setMsg({ queue, ok: true, text: 'DLQ config saved ✓' });
                  await refetch();
                }}
              />
            ) : (
              <ConfigLoadError title="DLQ policy" onRetry={refetch} />
            )}
          </div>
        </>
      )}
    </div>
  );
}
