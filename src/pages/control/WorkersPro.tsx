import { useEffect, useState } from 'react';
import { IconButton } from '@/components/ui/Button';
import { EmptyState, ErrorState, LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { IconTrash, IconWorkers } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatCard } from '@/components/ui/StatCard';
import { bq } from '@/lib/bq';
import { cn } from '@/lib/cn';
import { formatNumber, formatRelativeTime } from '@/lib/format';
import { usePolledData } from '@/lib/usePolledData';
import { assertSuccessfulMutationResponse, useServerActionGuard } from '@/lib/useServerActionGuard';

const MAX_ROWS = 100;

const STALE_EXPLAINER = 'No heartbeat recently — derived from lastSeen';

type SortKey = 'failed' | 'lastSeen';
interface Sort {
  key: SortKey;
  dir: 'asc' | 'desc';
}

export function WorkersPro() {
  // /workers wraps its payload: { ok, data: { workers } } — unwrap here so the
  // page renders a plain list.
  const { data, error, loading, refetch } = usePolledData(async () => {
    const r = await bq.workers();
    return r.data;
  }, []);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // null = server order (registration order); clicking a sortable header sorts.
  const [sort, setSort] = useState<Sort | null>(null);
  const actionGuard = useServerActionGuard('workers-pro');

  // biome-ignore lint/correctness/useExhaustiveDependencies: scopeKey is the connection lifecycle boundary
  useEffect(() => {
    setBusyIds(new Set());
    setMsg(null);
  }, [actionGuard.scopeKey]);

  if (loading && !data && !error) return <LoadingState label="Loading workers…" />;
  if (error && !data) {
    return (
      <div>
        <PageHeader title="Workers" description="Worker inventory is unavailable." />
        <ErrorState error={error} onRetry={refetch} />
      </div>
    );
  }

  const workers = data?.workers ?? [];
  const quarantinedWorkers = data?.quarantinedWorkers ?? [];
  const sorted = sort
    ? [...workers].sort((a, b) => {
        const va = sort.key === 'failed' ? (a.failedJobs ?? 0) : (a.lastSeen ?? 0);
        const vb = sort.key === 'failed' ? (b.failedJobs ?? 0) : (b.lastSeen ?? 0);
        return sort.dir === 'asc' ? va - vb : vb - va;
      })
    : workers;
  const rows = sorted.slice(0, MAX_ROWS);
  const toggleSort = (key: SortKey) =>
    setSort((s) =>
      s?.key === key ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' }
    );
  const activeWorkers = workers.filter((w) => w.status === 'active').length;
  const staleWorkers = workers.length - activeWorkers;
  const activeJobs = workers.reduce((sum, w) => sum + (w.activeJobs ?? 0), 0);

  const removeStaleRegistration = async (id: string) => {
    if (
      !window.confirm(
        `Remove the stale registry record for worker "${id}"? This does not stop the worker process. Continue only after confirming that process is stopped; Bunqueue v2.8.57 workers do not automatically re-register after their heartbeat record is removed.`
      )
    )
      return;
    const lease = actionGuard.begin(`worker:${id}`);
    if (!lease) return;
    setBusyIds((s) => new Set(s).add(id));
    setMsg(null);
    try {
      const response = await bq.unregisterWorker(id);
      assertSuccessfulMutationResponse(response, 'Remove stale worker registry record');
      if (!lease.isCurrent()) return;
      setMsg({ ok: true, text: `Removed stale registry record for ${id} ✓` });
      void refetch();
    } catch (e) {
      if (!lease.isCurrent()) return;
      setMsg({ ok: false, text: `Removal failed: ${(e as Error).message}` });
    } finally {
      if (lease.finish()) {
        setBusyIds((s) => {
          const n = new Set(s);
          n.delete(id);
          return n;
        });
      }
    }
  };

  return (
    <div>
      <PageHeader
        title="Workers"
        description="Registered workers and their throughput."
        live={!!data && !error}
      />
      {error && (
        <OfflineBanner
          message="Worker refresh failed — showing the last successful inventory."
          onRetry={refetch}
        />
      )}

      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-5">
        <StatCard
          label="Total"
          value={formatNumber(workers.length + quarantinedWorkers.length)}
          compact
        />
        <StatCard label="Active" value={formatNumber(activeWorkers)} tone="green" compact />
        <div title={STALE_EXPLAINER}>
          <StatCard
            label="Stale"
            value={formatNumber(staleWorkers)}
            tone={staleWorkers ? 'amber' : 'default'}
            compact
          />
        </div>
        <StatCard label="Active Jobs" value={formatNumber(activeJobs)} tone="blue" compact />
        <StatCard
          label="Quarantined"
          value={formatNumber(quarantinedWorkers.length)}
          tone={quarantinedWorkers.length ? 'red' : 'default'}
          compact
        />
      </div>

      {quarantinedWorkers.length > 0 && (
        <div role="alert" className="mb-4 rounded-lg border border-danger/30 bg-danger/5 p-4">
          <p className="text-sm font-medium text-danger">
            {quarantinedWorkers.length} worker registration(s) contain values accepted by Bunqueue
            2.8.55 but unsafe to render. Healthy workers remain available below.
          </p>
          <p className="mt-1 text-xs text-muted">
            Their status and active-job count are unknown, so this dashboard will not offer the
            registry-only removal action for them.
          </p>
          <ul className="mt-2 space-y-1 text-xs text-muted">
            {quarantinedWorkers.slice(0, 20).map((issue) => (
              <li key={`${issue.index}:${issue.id ?? 'unknown'}`} className="truncate font-mono">
                #{issue.index + 1} {issue.id ?? '(unaddressable id)'} — {issue.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {msg && (
        <div className={cn('mb-3 text-sm', msg.ok ? 'text-success' : 'text-danger')}>
          {msg.text}
        </div>
      )}

      {workers.length === 0 ? (
        <EmptyState
          icon={<IconWorkers />}
          title={quarantinedWorkers.length ? 'No renderable workers' : 'No workers registered'}
          hint={
            quarantinedWorkers.length
              ? 'Malformed registrations are isolated above instead of taking down the inventory.'
              : 'Workers appear here once they connect and register with the server.'
          }
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
                <th className="px-5 py-3 text-right font-medium">
                  <SortButton
                    label="Failed"
                    active={sort?.key === 'failed' ? sort.dir : null}
                    onClick={() => toggleSort('failed')}
                  />
                </th>
                <th className="px-5 py-3 text-right font-medium">
                  <SortButton
                    label="Last Seen"
                    active={sort?.key === 'lastSeen' ? sort.dir : null}
                    onClick={() => toggleSort('lastSeen')}
                  />
                </th>
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
                      title={w.status === 'active' ? undefined : STALE_EXPLAINER}
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
                      {w.status === 'stale' && w.activeJobs === 0 ? (
                        <IconButton
                          aria-label={`Remove stale registry record for worker ${w.id}`}
                          title="Registry cleanup only — does not stop the worker process"
                          disabled={busyIds.has(w.id)}
                          onClick={() => removeStaleRegistration(w.id)}
                        >
                          <IconTrash className="size-3.5" />
                        </IconButton>
                      ) : (
                        <span
                          className="text-xs text-faint"
                          title={
                            w.status === 'stale'
                              ? 'Registry cleanup is blocked while active jobs are reported'
                              : 'Only stale, idle registry records can be removed'
                          }
                        >
                          —
                        </span>
                      )}
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

/** Sortable column header: click toggles desc → asc; inherits the th typography. */
function SortButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: 'asc' | 'desc' | null;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={`Sort by ${label}`}
      className={cn(
        'inline-flex items-center gap-1 uppercase tracking-wider transition-colors hover:text-fg',
        active ? 'text-fg' : 'text-faint'
      )}
    >
      {label}
      <span aria-hidden="true">{active === 'desc' ? '↓' : active === 'asc' ? '↑' : ''}</span>
    </button>
  );
}
