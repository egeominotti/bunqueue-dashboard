import { useState } from 'react';
import { IconButton } from '@/components/ui/Button';
import { EmptyState, LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { IconTrash, IconWorkers } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatCard } from '@/components/ui/StatCard';
import { bq } from '@/lib/bq';
import type { WorkerFull } from '@/lib/bqTypes';
import { cn } from '@/lib/cn';
import { formatNumber, formatRelativeTime } from '@/lib/format';
import { usePolledData } from '@/lib/usePolledData';

const MAX_ROWS = 100;

export function WorkersPro() {
  // /workers wraps its payload: { ok, data: { workers } } — unwrap here so the
  // page renders a plain list.
  const { data, error, loading, refetch } = usePolledData(async () => {
    const r = await bq.workers();
    return r.data?.workers ?? [];
  }, []);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  if (loading && !data && !error) return <LoadingState label="Loading workers…" />;

  const workers = data ?? [];
  const rows = workers.slice(0, MAX_ROWS);
  const activeWorkers = workers.filter((w) => w.status === 'active').length;
  const staleWorkers = workers.length - activeWorkers;
  const activeJobs = workers.reduce((sum, w) => sum + (w.activeJobs ?? 0), 0);

  const unregister = async (w: WorkerFull) => {
    if (!window.confirm(`Unregister worker "${w.id}"? It can re-register on its next heartbeat.`))
      return;
    setBusyIds((s) => new Set(s).add(w.id));
    setMsg(null);
    try {
      await bq.unregisterWorker(w.id);
      setMsg({ ok: true, text: `Unregistered ${w.id} ✓` });
    } catch (e) {
      setMsg({ ok: false, text: `Unregister failed: ${(e as Error).message}` });
    } finally {
      setBusyIds((s) => {
        const n = new Set(s);
        n.delete(w.id);
        return n;
      });
      refetch();
    }
  };

  return (
    <div>
      <PageHeader
        title="Workers"
        description="Registered workers and their throughput."
        live={!error}
      />
      {error && <OfflineBanner onRetry={refetch} />}

      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label="Total" value={formatNumber(workers.length)} compact />
        <StatCard label="Active" value={formatNumber(activeWorkers)} tone="green" compact />
        <StatCard
          label="Stale"
          value={formatNumber(staleWorkers)}
          tone={staleWorkers ? 'amber' : 'default'}
          compact
        />
        <StatCard label="Active Jobs" value={formatNumber(activeJobs)} tone="blue" compact />
      </div>

      {msg && (
        <div className={cn('mb-3 text-sm', msg.ok ? 'text-success' : 'text-danger')}>
          {msg.text}
        </div>
      )}

      {workers.length === 0 ? (
        <EmptyState
          icon={<IconWorkers />}
          title="No workers registered"
          hint="Workers appear here once they connect and register with the server."
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-faint">
                <th className="px-5 py-3 font-medium">Worker</th>
                <th className="px-5 py-3 font-medium">Queues</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 text-right font-medium">Active</th>
                <th className="px-5 py-3 text-right font-medium">Processed</th>
                <th className="px-5 py-3 text-right font-medium">Failed</th>
                <th className="px-5 py-3 text-right font-medium">Last Seen</th>
                <th className="w-16 px-5 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((w) => (
                <tr key={w.id} className="border-b border-line last:border-0 hover:bg-surface-2/40">
                  <td className="px-5 py-3">
                    <div className="font-medium text-fg">{w.name || 'worker'}</div>
                    <div className="font-mono text-[11px] text-faint">{w.id}</div>
                  </td>
                  <td className="px-5 py-3 font-mono text-xs text-muted">
                    {w.queues.join(', ') || '—'}
                  </td>
                  <td className="px-5 py-3">
                    <span
                      className={cn(
                        'rounded-full px-2 py-0.5 text-[11px] font-medium',
                        w.status === 'active'
                          ? 'bg-emerald-500/10 text-success'
                          : 'bg-amber-500/10 text-warning'
                      )}
                    >
                      {w.status}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-right tnum text-blue-400">
                    {formatNumber(w.activeJobs)}
                  </td>
                  <td className="px-5 py-3 text-right tnum text-muted">
                    {formatNumber(w.processedJobs)}
                  </td>
                  <td className="px-5 py-3 text-right tnum text-muted">
                    {formatNumber(w.failedJobs)}
                  </td>
                  <td className="px-5 py-3 text-right text-faint">
                    {formatRelativeTime(w.lastSeen)}
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex justify-end">
                      <IconButton
                        aria-label={`Unregister worker ${w.id}`}
                        disabled={busyIds.has(w.id)}
                        onClick={() => unregister(w)}
                      >
                        <IconTrash className="size-3.5" />
                      </IconButton>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {workers.length > MAX_ROWS && (
        <p className="mt-3 text-xs text-warning">
          Showing first {formatNumber(MAX_ROWS)} of {formatNumber(workers.length)} workers.
        </p>
      )}
    </div>
  );
}
