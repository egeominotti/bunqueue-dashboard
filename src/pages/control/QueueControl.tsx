import { useCallback, useEffect, useState } from 'react';
import { ErrorState, LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { Select } from '@/components/ui/form';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatCard } from '@/components/ui/StatCard';
import { StatusDot } from '@/components/ui/StatusBadge';
import { bq } from '@/lib/bq';
import { formatNumber } from '@/lib/format';
import type { QueuesResponse } from '@/lib/types';
import { usePolledData } from '@/lib/usePolledData';
import { useServerActionGuard } from '@/lib/useServerActionGuard';
import {
  ConfigLoadError,
  DlqConfigForm,
  isDlqConfig,
  isStallConfig,
  StallForm,
} from './queue/ConfigForms';
import { LifecycleCard, LimitsCards } from './queue/QueueActions';

const COUNT_KEYS = [
  'waiting',
  'prioritized',
  'active',
  'completed',
  'failed',
  'delayed',
  'waiting-children',
  'paused',
] as const;
const QUEUE_PAGE_SIZE = 500;
const MAX_QUEUE_PAGES = 200;
const MAX_DISCOVERED_QUEUES = QUEUE_PAGE_SIZE * MAX_QUEUE_PAGES;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function hasRenderedCounts(value: unknown): value is Record<(typeof COUNT_KEYS)[number], number> {
  return isRecord(value) && COUNT_KEYS.every((key) => isCount(value[key]));
}

function assertQueuePage(value: unknown, expectedOffset: number): asserts value is QueuesResponse {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    !Array.isArray(value.queues) ||
    !isCount(value.total) ||
    !isCount(value.limit) ||
    value.limit < 1 ||
    !isCount(value.offset) ||
    value.offset !== expectedOffset ||
    typeof value.timestamp !== 'number' ||
    !Number.isFinite(value.timestamp) ||
    !value.queues.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.name === 'string' &&
        entry.name.length > 0 &&
        isCount(entry.waiting) &&
        isCount(entry.delayed) &&
        isCount(entry.active) &&
        isCount(entry.dlq) &&
        typeof entry.paused === 'boolean'
    )
  ) {
    throw new Error('Malformed /dashboard/queues response.');
  }
}

/** Fetch every server page; v2.8.55 caps each /dashboard/queues page at 500. */
export async function loadAllQueuePages(): Promise<QueuesResponse> {
  const first = await bq.queues(QUEUE_PAGE_SIZE, 0);
  assertQueuePage(first, 0);
  const snapshotTotal = first.total;
  if (snapshotTotal > MAX_DISCOVERED_QUEUES) {
    throw new Error(
      `Queue discovery reported ${snapshotTotal} queues, above the safe dashboard limit of ${MAX_DISCOVERED_QUEUES}.`
    );
  }
  if (first.queues.length !== Math.min(QUEUE_PAGE_SIZE, snapshotTotal)) {
    throw new Error(
      `Incomplete /dashboard/queues page at offset 0: expected ${Math.min(QUEUE_PAGE_SIZE, snapshotTotal)} queues, received ${first.queues.length}.`
    );
  }

  const byName = new Map<string, QueuesResponse['queues'][number]>();
  const addPage = (page: QueuesResponse) => {
    for (const entry of page.queues) {
      if (byName.has(entry.name)) {
        throw new Error(
          `Overlapping /dashboard/queues pages: queue "${entry.name}" appeared more than once.`
        );
      }
      byName.set(entry.name, entry);
    }
  };
  addPage(first);
  let offset = first.queues.length;
  let pageCount = 1;

  // v2.8.55 pagination is not a server-side snapshot. Treat a changed total as
  // a stale read and let the next poll retry from page zero instead of chasing
  // a moving target forever or silently composing overlapping pages.
  while (offset < snapshotTotal) {
    if (pageCount >= MAX_QUEUE_PAGES) {
      throw new Error(`Queue discovery exceeded the safe limit of ${MAX_QUEUE_PAGES} pages.`);
    }
    const page = await bq.queues(QUEUE_PAGE_SIZE, offset);
    assertQueuePage(page, offset);
    if (page.total !== snapshotTotal) {
      throw new Error(
        `Queue discovery changed during pagination: total moved from ${snapshotTotal} to ${page.total}. Retry the snapshot.`
      );
    }
    const expectedLength = Math.min(QUEUE_PAGE_SIZE, snapshotTotal - offset);
    if (page.queues.length !== expectedLength) {
      throw new Error(
        `Incomplete /dashboard/queues page at offset ${offset}: expected ${expectedLength} queues, received ${page.queues.length}.`
      );
    }
    addPage(page);
    offset += page.queues.length;
    pageCount += 1;
  }

  if (byName.size !== snapshotTotal) {
    throw new Error(
      `Incomplete /dashboard/queues snapshot: expected ${snapshotTotal} unique queues, received ${byName.size}.`
    );
  }

  return {
    ...first,
    queues: [...byName.values()],
    total: snapshotTotal,
    limit: QUEUE_PAGE_SIZE,
    offset: 0,
  };
}

function assertQueueDetail(value: unknown, expectedQueue: string): void {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    value.name !== expectedQueue ||
    typeof value.paused !== 'boolean' ||
    !hasRenderedCounts(value.counts)
  ) {
    throw new Error(`Malformed queue detail response for "${expectedQueue}".`);
  }
}

function readStallConfig(value: unknown) {
  if (!isRecord(value) || value.ok !== true || !isStallConfig(value.config)) {
    throw new Error('Malformed /stall-config response.');
  }
  return value.config;
}

function readDlqConfig(value: unknown) {
  if (!isRecord(value) || value.ok !== true || !isDlqConfig(value.config)) {
    throw new Error('Malformed /dlq-config response.');
  }
  return value.config;
}

export function actionResultCount(value: unknown): number | undefined {
  if (!isRecord(value) || value.ok !== true) {
    throw new Error('Malformed queue action response: expected { ok: true }.');
  }
  if (value.count === undefined) return undefined;
  if (!isCount(value.count)) {
    throw new Error('Malformed queue action response: count must be a non-negative integer.');
  }
  return value.count;
}

export function resolveQueueSelection(
  selected: string,
  queues: ReadonlyArray<{ name: string }>
): string {
  return queues.some((entry) => entry.name === selected) ? selected : (queues[0]?.name ?? '');
}

export function QueueControl() {
  const [queue, setQueue] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ queue: string; ok: boolean; text: string } | null>(null);
  const actionGuard = useServerActionGuard(`queue-control:${queue}`);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scopeKey is the queue+connection lifecycle boundary
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
  const data = raw && raw.queue === queue && queueIsDiscovered ? raw : null;

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
