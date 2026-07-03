import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from '@/components/dashboard/stores/toastStore';
import { Button, IconButton } from '@/components/ui/Button';
import { LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { IconArrowRight, IconPause, IconPlay, IconQueues, IconSearch } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { StatCard } from '@/components/ui/StatCard';
import { bq } from '@/lib/bq';
import type { QueueSummaryFull } from '@/lib/bqTypes';
import { cn } from '@/lib/cn';
import { formatNumber } from '@/lib/format';
import { settledPool } from '@/lib/promisePool';
import { usePolledData } from '@/lib/usePolledData';

const FANOUT_LIMIT = 6;

const PAGE_SIZE = 15;

/**
 * All queues with per-state counts and inline pause/resume. Backed by a single
 * `GET /queues/summary` call per poll (not an N-queue fan-out), then filtered
 * and paginated client-side. Pause is the first thing you reach for in an
 * incident, so it lives on every row.
 */
export function QueuesOverview() {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const { data, error, loading, refetch } = usePolledData(() => bq.queuesSummary(), []);
  const all = data ?? [];

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    const list = term ? all.filter((q) => q.name.toLowerCase().includes(term)) : all;
    return [...list].sort((a, b) => a.name.localeCompare(b.name));
  }, [all, search]);

  const totals = useMemo(
    () =>
      all.reduce(
        (a, q) => {
          a.waiting += q.counts.waiting;
          a.active += q.counts.active;
          a.failed += q.counts.failed;
          a.paused += q.paused ? 1 : 0;
          return a;
        },
        { waiting: 0, active: 0, failed: 0, paused: 0 }
      ),
    [all]
  );

  // Clamp the page if the filter shrank the list below the current offset.
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const rows = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  const toggle = async (q: QueueSummaryFull) => {
    setBusy((s) => new Set(s).add(q.name));
    setMsg(null);
    try {
      await (q.paused ? bq.resume(q.name) : bq.pause(q.name));
      setMsg({ ok: true, text: `${q.name} ${q.paused ? 'resumed' : 'paused'} ✓` });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
      toast.error(`Failed to ${q.paused ? 'resume' : 'pause'} ${q.name}`, (e as Error).message);
    } finally {
      setBusy((s) => {
        const n = new Set(s);
        n.delete(q.name);
        return n;
      });
      refetch();
    }
  };

  // Freeze or unfreeze every queue in one action — the first reflex during an
  // incident/deploy. Fans out over the current summary, skipping queues already
  // in the target state; tolerates per-queue failures.
  const bulkToggle = async (target: 'pause' | 'resume') => {
    const targets = all.filter((q) => (target === 'pause' ? !q.paused : q.paused));
    if (targets.length === 0) {
      toast.info(`No queues to ${target}`);
      return;
    }
    if (!window.confirm(`${target === 'pause' ? 'Pause' : 'Resume'} ${targets.length} queue(s)?`))
      return;
    setBulkBusy(true);
    setMsg(null);
    const results = await settledPool(targets, FANOUT_LIMIT, (q) =>
      target === 'pause' ? bq.pause(q.name) : bq.resume(q.name)
    );
    const failures = results.filter((r) => r.status === 'rejected').length;
    const text = `${target === 'pause' ? 'Paused' : 'Resumed'} ${targets.length - failures}/${targets.length} queues${
      failures ? `, ${failures} failed` : ''
    }`;
    setMsg({ ok: failures === 0, text });
    if (failures === 0) toast.success(text);
    else toast.error(text);
    setBulkBusy(false);
    refetch();
  };

  if (loading && !data && !error) return <LoadingState label="Loading queues…" />;

  return (
    <div>
      <PageHeader
        title="Queues"
        description={`${all.length} queues`}
        live
        actions={
          all.length > 0 ? (
            <>
              <Button
                variant="warning"
                size="sm"
                disabled={bulkBusy || totals.paused >= all.length}
                onClick={() => bulkToggle('pause')}
              >
                <IconPause className="size-3.5" /> Pause all
              </Button>
              <Button
                variant="success"
                size="sm"
                disabled={bulkBusy || totals.paused === 0}
                onClick={() => bulkToggle('resume')}
              >
                <IconPlay className="size-3.5" /> Resume all
              </Button>
            </>
          ) : undefined
        }
      />

      {error && <OfflineBanner onRetry={refetch} />}

      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label="Waiting" value={formatNumber(totals.waiting)} tone="amber" compact />
        <StatCard label="Active" value={formatNumber(totals.active)} tone="blue" compact />
        <StatCard
          label="Failed"
          value={formatNumber(totals.failed)}
          tone={totals.failed ? 'red' : 'default'}
          compact
        />
        <StatCard
          label="Paused"
          value={formatNumber(totals.paused)}
          tone={totals.paused ? 'amber' : 'default'}
          compact
        />
      </div>

      <div className="relative mb-4 max-w-sm">
        <IconSearch className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
        <input
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(0);
          }}
          placeholder="Search queues…"
          aria-label="Filter queues"
          className="h-9 w-full rounded-lg border border-line bg-surface pl-9 pr-3 text-sm text-fg placeholder:text-faint focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/30"
        />
      </div>

      {msg && (
        <div className={cn('mb-3 text-sm', msg.ok ? 'text-success' : 'text-danger')}>
          {msg.text}
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-line bg-surface">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-faint">
              <th className="px-5 py-3 font-medium">Queue</th>
              <th className="px-5 py-3 text-right font-medium">Waiting</th>
              <th className="px-5 py-3 text-right font-medium">Active</th>
              <th className="px-5 py-3 text-right font-medium">Completed</th>
              <th className="px-5 py-3 text-right font-medium">Failed</th>
              <th className="px-5 py-3 text-right font-medium">Delayed</th>
              <th className="px-5 py-3 font-medium">Status</th>
              <th className="w-24 px-5 py-3 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-5 py-12 text-center text-sm text-faint">
                  {search ? 'No queues match your search.' : 'No queues yet.'}
                </td>
              </tr>
            ) : (
              rows.map((q) => {
                const rowBusy = busy.has(q.name);
                return (
                  <tr
                    key={q.name}
                    onClick={() => navigate(`/queues/${encodeURIComponent(q.name)}`)}
                    className="group cursor-pointer border-b border-line last:border-0 transition-colors hover:bg-surface-2/50"
                  >
                    <td className="px-5 py-3">
                      {/* Real link = keyboard/focus access; tr onClick stays as pointer convenience. */}
                      <Link
                        to={`/queues/${encodeURIComponent(q.name)}`}
                        onClick={(e) => e.stopPropagation()}
                        className="flex items-center gap-2 rounded font-medium text-fg hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                      >
                        <IconQueues className="size-4 text-faint" />
                        {q.name}
                      </Link>
                    </td>
                    <td className="px-5 py-3 text-right tnum text-warning">
                      {formatNumber(q.counts.waiting)}
                    </td>
                    <td className="px-5 py-3 text-right tnum text-blue-400">
                      {formatNumber(q.counts.active)}
                    </td>
                    <td className="px-5 py-3 text-right tnum text-success">
                      {formatNumber(q.counts.completed)}
                    </td>
                    <td
                      className={cn(
                        'px-5 py-3 text-right tnum',
                        q.counts.failed ? 'text-danger' : 'text-muted'
                      )}
                    >
                      {formatNumber(q.counts.failed)}
                    </td>
                    <td className="px-5 py-3 text-right tnum text-muted">
                      {formatNumber(q.counts.delayed)}
                    </td>
                    <td className="px-5 py-3">
                      <span
                        className={cn(
                          'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium',
                          q.paused
                            ? 'bg-orange-500/10 text-orange-400'
                            : 'bg-emerald-500/10 text-success'
                        )}
                      >
                        <span className="size-1.5 rounded-full bg-current" />
                        {q.paused ? 'Paused' : 'Active'}
                      </span>
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <IconButton
                          aria-label={q.paused ? 'Resume queue' : 'Pause queue'}
                          disabled={rowBusy}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggle(q);
                          }}
                        >
                          {q.paused ? (
                            <IconPlay className="size-3.5 text-success" />
                          ) : (
                            <IconPause className="size-3.5 text-warning" />
                          )}
                        </IconButton>
                        <IconArrowRight className="size-4 text-faint opacity-0 transition-opacity group-hover:opacity-100" />
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <Pagination
        page={safePage}
        pageSize={PAGE_SIZE}
        total={filtered.length}
        onPageChange={setPage}
        label="queues"
      />
    </div>
  );
}
