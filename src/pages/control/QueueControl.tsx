import { useCallback, useEffect, useState } from 'react';
import { LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { Select } from '@/components/ui/form';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatCard } from '@/components/ui/StatCard';
import { StatusDot } from '@/components/ui/StatusBadge';
import { bq } from '@/lib/bq';
import { formatNumber } from '@/lib/format';
import { usePolledData } from '@/lib/usePolledData';
import { DlqConfigForm, StallForm } from './queue/ConfigForms';
import { LifecycleCard, LimitsCards } from './queue/QueueActions';

const COUNT_KEYS = ['waiting', 'active', 'completed', 'failed', 'delayed', 'paused'] as const;

export function QueueControl() {
  const [queue, setQueue] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Queue picker only — the queue set changes rarely, so poll it slowly instead
  // of on the fast global cadence (the live per-queue data has its own poll below).
  const { data: qs } = usePolledData(() => bq.queues(), [], { intervalMs: 30000 });
  useEffect(() => {
    if (!queue && qs?.queues?.length) setQueue(qs.queues[0].name);
  }, [qs, queue]);

  const fetcher = useCallback(async () => {
    if (!queue) return null;
    const [detail, stall, dlq] = await Promise.all([
      bq.queueDetail(queue, false),
      bq.getStallConfig(queue).catch(() => null),
      bq.getDlqConfig(queue).catch(() => null),
    ]);
    // Tagged with the queue it was fetched for, so a queue switch can't render
    // (or worse, save) queue A's config under queue B's name for one round-trip.
    return { queue, detail, stall: stall?.config ?? null, dlq: dlq?.config ?? null };
  }, [queue]);
  const { data: raw, error, loading, refetch } = usePolledData(fetcher, [queue]);
  const data = raw && raw.queue === queue ? raw : null;

  const run = (label: string, fn: () => Promise<unknown>, confirmMsg?: string) => {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    setBusy(true);
    setMsg(null);
    fn()
      .then((r) => {
        const count = (r as { count?: number })?.count;
        setMsg({ ok: true, text: `${label}${count != null ? `: ${count}` : ' ✓'}` });
        refetch();
      })
      .catch((e: unknown) => setMsg({ ok: false, text: (e as Error).message }))
      .finally(() => setBusy(false));
  };

  return (
    <div>
      <PageHeader
        title="Queue Control"
        description="Full per-queue operations and configuration."
        live
      />

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <div className="w-56">
          <Select value={queue} onChange={(e) => setQueue(e.target.value)}>
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
        {msg && (
          <span className={msg.ok ? 'text-xs text-emerald-400' : 'text-xs text-red-400'}>
            {msg.text}
          </span>
        )}
      </div>

      {error && <OfflineBanner onRetry={refetch} />}

      {loading && !data && !error ? (
        <LoadingState />
      ) : !data?.detail ? (
        !error && <p className="text-sm text-faint">Select a queue.</p>
      ) : (
        <>
          <div className="mb-6 grid grid-cols-3 gap-3 md:grid-cols-6">
            {COUNT_KEYS.map((k) => (
              <StatCard key={k} label={k} value={formatNumber(data.detail.counts[k])} compact />
            ))}
          </div>

          <LifecycleCard queue={queue} paused={data.detail.paused} busy={busy} run={run} />
          <LimitsCards queue={queue} busy={busy} run={run} />

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            {data.stall && (
              <StallForm
                key={queue}
                queue={queue}
                config={data.stall}
                onSaved={() => setMsg({ ok: true, text: 'Stall config saved ✓' })}
              />
            )}
            {data.dlq && (
              <DlqConfigForm
                key={queue}
                queue={queue}
                config={data.dlq}
                onSaved={() => setMsg({ ok: true, text: 'DLQ config saved ✓' })}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}
