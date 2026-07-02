import { useState } from 'react';
import { Button, IconButton } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { EmptyState, LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { Field, Input, SegmentedControl } from '@/components/ui/form';
import { IconCron, IconTrash } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { bq, type CreateCronBody } from '@/lib/bq';
import { formatDateTime, formatNumber } from '@/lib/format';
import { usePolledData } from '@/lib/usePolledData';

export function CronManager() {
  const { data, error, loading, refetch } = usePolledData(() => bq.crons(), []);
  const crons = data?.crons ?? [];
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 15;
  const pageCount = Math.max(1, Math.ceil(crons.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);

  const [actErr, setActErr] = useState<string | null>(null);
  const remove = async (name: string) => {
    if (!window.confirm(`Delete cron "${name}"?`)) return;
    setActErr(null);
    try {
      await bq.deleteCron(name);
      refetch();
    } catch (e) {
      // A confirmed delete that silently no-ops reads as "it worked" — say why.
      setActErr((e as Error).message);
    }
  };

  return (
    <div>
      {error && <OfflineBanner onRetry={refetch} />}
      <PageHeader title="Cron Manager" description="Schedule and manage repeatable jobs." live />
      {actErr && (
        <div className="mb-4 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-2 text-sm text-red-400">
          {actErr}
        </div>
      )}

      <Card className="mb-6">
        <CardHeader title="Create schedule" />
        <CronForm
          onCreate={async (b) => {
            await bq.createCron(b);
            refetch();
          }}
        />
      </Card>

      {loading && !data && !error ? (
        <LoadingState label="Loading crons…" />
      ) : crons.length === 0 ? (
        <EmptyState icon={<IconCron />} title="No scheduled jobs" hint="Create one above." />
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
                    <td className="px-5 py-3 font-mono text-xs text-muted">{c.queue}</td>
                    <td className="px-5 py-3 font-mono text-xs text-muted">
                      {c.schedule ?? (c.repeatEvery ? `every ${c.repeatEvery}ms` : '—')}
                    </td>
                    <td className="px-5 py-3 text-faint">{formatDateTime(c.nextRun)}</td>
                    <td className="px-5 py-3 text-right tnum text-muted">
                      {formatNumber(c.executions)}
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

function CronForm({ onCreate }: { onCreate: (b: CreateCronBody) => Promise<void> }) {
  const [name, setName] = useState('');
  const [queue, setQueue] = useState('');
  const [mode, setMode] = useState<'cron' | 'every'>('cron');
  const [schedule, setSchedule] = useState('');
  const [every, setEvery] = useState('');
  const [dataText, setDataText] = useState('{}');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return; // double-click would create the cron twice
    setErr(null);
    if (!name.trim() || !queue.trim()) {
      setErr('Name and queue are required');
      return;
    }
    let data: unknown = {};
    try {
      data = dataText.trim() ? JSON.parse(dataText) : {};
    } catch {
      setErr('Data is not valid JSON');
      return;
    }
    const body: CreateCronBody = { name, queue, data };
    if (mode === 'cron') {
      if (!schedule.trim()) {
        setErr('Cron expression required');
        return;
      }
      body.schedule = schedule.trim();
    } else {
      const ms = Number(every);
      if (!ms) {
        setErr('Interval (ms) required');
        return;
      }
      body.repeatEvery = ms;
    }
    setBusy(true);
    try {
      await onCreate(body);
      setName('');
      setSchedule('');
      setEvery('');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="daily-report"
          />
        </Field>
        <Field label="Queue">
          <Input value={queue} onChange={(e) => setQueue(e.target.value)} placeholder="reports" />
        </Field>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <SegmentedControl options={['cron', 'every'] as const} value={mode} onChange={setMode} />
        {mode === 'cron' ? (
          <div className="min-w-56 flex-1">
            <Field label="Cron expression">
              <Input
                value={schedule}
                onChange={(e) => setSchedule(e.target.value)}
                placeholder="0 9 * * *"
              />
            </Field>
          </div>
        ) : (
          <div className="w-40">
            <Field label="Every (ms)">
              <Input
                type="number"
                value={every}
                onChange={(e) => setEvery(e.target.value)}
                placeholder="30000"
              />
            </Field>
          </div>
        )}
      </div>
      <Field label="Data (JSON)">
        <Input
          value={dataText}
          onChange={(e) => setDataText(e.target.value)}
          className="font-mono"
        />
      </Field>
      <div className="flex items-center gap-3">
        <Button variant="accent" size="sm" onClick={submit} disabled={busy}>
          {busy ? 'Creating…' : 'Create'}
        </Button>
        {err && <span className="text-xs text-red-400">{err}</span>}
      </div>
    </div>
  );
}
