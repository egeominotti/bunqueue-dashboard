import { useState } from 'react';
import { IconButton } from '@/components/ui/Button';
import { EmptyState, LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { IconCron, IconTrash } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { api } from '@/lib/api';
import { formatDateTime, formatNumber } from '@/lib/format';
import { usePolledData } from '@/lib/usePolledData';

interface Cron {
  name: string;
  queue?: string;
  schedule?: string | null;
  repeatEvery?: number | null;
  nextRun?: number;
  executions?: number;
  timezone?: string;
}

export function Cron() {
  const { data, error, loading, refetch } = usePolledData(() => api.crons(), []);

  const crons = ((data?.crons ?? []) as Cron[]).slice();
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 15;
  const pageCount = Math.max(1, Math.ceil(crons.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);

  const remove = async (name: string) => {
    if (!window.confirm(`Delete cron "${name}"?`)) return;
    try {
      await api.deleteCron(name);
      refetch();
    } catch {
      /* next poll reflects state */
    }
  };

  return (
    <div>
      {error && <OfflineBanner onRetry={refetch} />}
      <PageHeader title="Cron Jobs" description={`${crons.length} scheduled`} live />

      {loading && !data && !error ? (
        <LoadingState label="Loading cron jobs…" />
      ) : crons.length === 0 ? (
        <EmptyState
          icon={<IconCron />}
          title="No scheduled jobs"
          hint="Repeatable jobs created with upsertJobScheduler appear here."
        />
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border border-line bg-surface">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-faint">
                  <th className="px-5 py-3 font-medium">Name</th>
                  <th className="px-5 py-3 font-medium">Queue</th>
                  <th className="px-5 py-3 font-medium">Schedule</th>
                  <th className="px-5 py-3 font-medium">Next Run</th>
                  <th className="px-5 py-3 text-right font-medium">Runs</th>
                  <th className="w-12 px-5 py-3" />
                </tr>
              </thead>
              <tbody>
                {crons.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE).map((c) => (
                  <tr
                    key={c.name}
                    className="border-b border-line last:border-0 hover:bg-surface-2/40"
                  >
                    <td className="px-5 py-3 font-medium text-fg">{c.name}</td>
                    <td className="px-5 py-3 font-mono text-xs text-muted">{c.queue ?? '—'}</td>
                    <td className="px-5 py-3 font-mono text-xs text-muted">
                      {c.schedule ?? (c.repeatEvery ? `every ${c.repeatEvery}ms` : '—')}
                    </td>
                    <td className="px-5 py-3 text-faint">{formatDateTime(c.nextRun)}</td>
                    <td className="px-5 py-3 text-right tnum text-muted">
                      {formatNumber(c.executions ?? 0)}
                    </td>
                    <td className="px-5 py-3 text-right">
                      <IconButton aria-label="Delete cron" onClick={() => remove(c.name)}>
                        <IconTrash className="size-3.5" />
                      </IconButton>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            page={safePage}
            pageSize={PAGE_SIZE}
            total={crons.length}
            onPageChange={setPage}
            label="crons"
          />
        </>
      )}
    </div>
  );
}
