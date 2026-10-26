import { useEffect, useState } from 'react';
import { EmptyState, ErrorState, LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { IconWorkers } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { StatCard } from '@/components/ui/StatCard';
import { bq } from '@/lib/bq';
import { cn } from '@/lib/cn';
import { formatNumber } from '@/lib/format';
import { usePolledData } from '@/lib/usePolledData';
import { assertSuccessfulMutationResponse, useServerActionGuard } from '@/lib/useServerActionGuard';
import { STALE_EXPLAINER, type Sort, type SortKey, WorkersTable } from './workers/WorkersTable';

const PAGE_SIZE = 100;

export function WorkersPro() {
  const { data, error, loading, refetch } = usePolledData(async () => {
    const r = await bq.workers();
    return r.data;
  }, []);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [sort, setSort] = useState<Sort | null>(null);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const actionGuard = useServerActionGuard('workers-pro');

  // scopeKey is the connection lifecycle boundary.
  useEffect(() => {
    setBusyIds(new Set());
    setMsg(null);
    setPage(0);
    setSearch('');
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
  const term = search.trim().toLowerCase();
  const filtered = term
    ? sorted.filter((worker) =>
        [worker.name, worker.id, worker.hostname, worker.status, ...worker.queues].some((value) =>
          value.toLowerCase().includes(term)
        )
      )
    : sorted;
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1));
  const rows = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const toggleSort = (key: SortKey) => {
    setPage(0);
    setSort((s) =>
      s?.key === key ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' }
    );
  };
  const activeWorkers = workers.filter((w) => w.status === 'active').length;
  const staleWorkers = workers.length - activeWorkers;
  const activeJobs = workers.reduce((sum, w) => sum + (w.activeJobs ?? 0), 0);

  const removeStaleRegistration = async (id: string) => {
    if (
      !window.confirm(
        `Remove the stale registry record for worker "${id}"? This does not stop the worker process. Continue only after confirming that process is stopped; Bunqueue v2.9.3 workers do not automatically re-register after their heartbeat record is removed.`
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
            2.9.3 but unsafe to render. Healthy workers remain available below.
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

      {workers.length > 0 && (
        <div className="mb-4">
          <input
            aria-label="Search workers"
            name="workers-search"
            value={search}
            onInput={(event) => {
              setSearch(event.currentTarget.value);
              setPage(0);
            }}
            placeholder="Search workers, queues or hosts…"
            className="h-9 w-full max-w-sm rounded-lg border border-line bg-surface px-3 text-sm text-fg placeholder:text-faint focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
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
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<IconWorkers />}
          title="No workers match your search"
          hint="Try a different name, ID, queue, host, or status."
        />
      ) : (
        <>
          <WorkersTable
            rows={rows}
            sort={sort}
            busyIds={busyIds}
            onSort={toggleSort}
            onRemove={(id) => void removeStaleRegistration(id)}
          />
          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={filtered.length}
            onPageChange={setPage}
            label="workers"
          />
        </>
      )}
    </div>
  );
}
