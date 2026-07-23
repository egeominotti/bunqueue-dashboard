import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from '@/components/dashboard/stores/toastStore';
import { Button, IconButton } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { EmptyState, LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { Field, Input, SegmentedControl, Toggle } from '@/components/ui/form';
import { IconCron, IconTrash } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { bq, type CreateCronBody, type CronJobOptions } from '@/lib/bq';
import { cn } from '@/lib/cn';
import { nextCronRuns } from '@/lib/cronPreview';
import { formatDateTime, formatNumber } from '@/lib/format';
import { usePolledData } from '@/lib/usePolledData';

/**
 * Page state clamped to the live page count. Clamps the STATE, not just the
 * rendered value: with only the render clamped, a list that shrinks (delete)
 * and then regrows (create) jumps the table to a page nobody navigated to.
 */
export function useClampedPage(pageCount: number): [number, (p: number) => void] {
  const [page, setPage] = useState(0);
  useEffect(() => {
    if (page > pageCount - 1) setPage(pageCount - 1);
  }, [page, pageCount]);
  return [Math.min(page, pageCount - 1), setPage];
}

/**
 * A confirmation flag that auto-clears after `ms`. The timer handle is kept and
 * restarted on every `fire()`, so back-to-back creates each get their full
 * window (an unheld timer from create N would erase create N+1's badge), and it
 * is cleared on unmount.
 */
export function useTransientFlag(ms: number): {
  on: boolean;
  fire: () => void;
  reset: () => void;
} {
  const [on, setOn] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );
  return {
    on,
    fire: () => {
      clear();
      setOn(true);
      timer.current = setTimeout(() => setOn(false), ms);
    },
    reset: () => {
      clear();
      setOn(false);
    },
  };
}

export function CronManager() {
  const { data, error, loading, refetch } = usePolledData(() => bq.crons(), []);
  const crons = data?.crons ?? [];
  const PAGE_SIZE = 15;
  const pageCount = Math.max(1, Math.ceil(crons.length / PAGE_SIZE));
  const [safePage, setPage] = useClampedPage(pageCount);

  const [actErr, setActErr] = useState<string | null>(null);
  const remove = async (name: string) => {
    if (!window.confirm(`Delete cron "${name}"?`)) return;
    setActErr(null);
    try {
      await bq.deleteCron(name);
      toast.success('Cron deleted', name);
      refetch();
    } catch (e) {
      // A confirmed delete that silently no-ops reads as "it worked" — say why.
      setActErr((e as Error).message);
      toast.error('Delete cron failed', (e as Error).message);
    }
  };

  return (
    <div>
      {error && <OfflineBanner onRetry={refetch} />}
      <PageHeader title="Cron Manager" description="Schedule and manage repeatable jobs." live />
      {actErr && (
        <div
          role="status"
          className="mb-4 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-2 text-sm text-danger"
        >
          {actErr}
        </div>
      )}

      <Card className="mb-6">
        <CardHeader title="Create schedule" />
        <CronForm
          onCreate={async (b) => {
            await bq.createCron(b);
            toast.success('Cron created', b.name);
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
                  <th scope="col" className="px-5 py-3 font-medium">
                    Name
                  </th>
                  <th scope="col" className="px-5 py-3 font-medium">
                    Queue
                  </th>
                  <th scope="col" className="px-5 py-3 font-medium">
                    Schedule
                  </th>
                  <th scope="col" className="px-5 py-3 font-medium">
                    Next Run
                  </th>
                  <th scope="col" className="px-5 py-3 text-right font-medium">
                    Runs
                  </th>
                  <th scope="col" className="w-12 px-5 py-3" />
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

/** "30000" → "every 30s"; non-round intervals get a ≈ prefix ("≈ every 1.5m"). */
function everyPreview(raw: string): string | null {
  const ms = Number(raw);
  if (!Number.isInteger(ms) || ms <= 0) return null;
  if (ms < 1000) return `every ${ms}ms`;
  const units = [
    [86_400_000, 'd'],
    [3_600_000, 'h'],
    [60_000, 'm'],
    [1000, 's'],
  ] as const;
  for (const [size, suffix] of units) {
    if (ms >= size) {
      const v = ms / size;
      return `${Number.isInteger(v) ? '' : '≈ '}every ${Math.round(v * 10) / 10}${suffix}`;
    }
  }
  return null;
}

function CronForm({ onCreate }: { onCreate: (b: CreateCronBody) => Promise<void> }) {
  const [name, setName] = useState('');
  const [queue, setQueue] = useState('');
  const [mode, setMode] = useState<'cron' | 'every'>('cron');
  const [schedule, setSchedule] = useState('');
  const [every, setEvery] = useState('');
  const [dataText, setDataText] = useState('{}');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [timezone, setTimezone] = useState('');
  const [priority, setPriority] = useState('');
  const [preventOverlap, setPreventOverlap] = useState(false);
  const [skipIfNoWorker, setSkipIfNoWorker] = useState(false);
  const [maxLimit, setMaxLimit] = useState('');
  const [immediately, setImmediately] = useState(false);
  const [skipMissedOnRestart, setSkipMissedOnRestart] = useState(false);
  const [jobMaxAttempts, setJobMaxAttempts] = useState('');
  const [jobBackoff, setJobBackoff] = useState('');
  const [jobTimeout, setJobTimeout] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { on: created, fire: fireCreated, reset: resetCreated } = useTransientFlag(3000);

  // Live preview of the next fire times so a typo (9 0 * * * vs 0 9 * * *) is
  // caught before the schedule is created. Computed in the browser's local
  // timezone; a server-side timezone is noted separately.
  const preview = useMemo(() => {
    if (mode !== 'cron' || !schedule.trim()) return null;
    return nextCronRuns(schedule.trim(), 3, Date.now());
  }, [mode, schedule]);

  const submit = async () => {
    if (busy) return; // double-click would create the cron twice
    setErr(null);
    resetCreated();
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
    // Persist exactly what was validated — an invisible trailing space would
    // schedule into a phantom queue (or duplicate an existing schedule).
    const body: CreateCronBody = { name: name.trim(), queue: queue.trim(), data };
    if (mode === 'cron') {
      if (!schedule.trim()) {
        setErr('Cron expression required');
        return;
      }
      if (preview && !preview.valid) {
        setErr(preview.error ?? 'Invalid cron expression');
        return;
      }
      body.schedule = schedule.trim();
    } else {
      const ms = Number(every);
      if (!Number.isInteger(ms) || ms <= 0) {
        setErr('Interval must be a whole number of milliseconds greater than 0');
        return;
      }
      body.repeatEvery = ms;
    }
    if (timezone.trim()) body.timezone = timezone.trim();
    const prio = Number(priority);
    if (priority.trim() !== '' && Number.isFinite(prio)) body.priority = prio;
    if (preventOverlap) body.preventOverlap = true;
    if (skipIfNoWorker) body.skipIfNoWorker = true;
    const ml = Number(maxLimit);
    if (maxLimit.trim() !== '' && Number.isInteger(ml) && ml > 0) body.maxLimit = ml;
    if (immediately) body.immediately = true;
    if (skipMissedOnRestart) body.skipMissedOnRestart = true;
    const jobOptions: CronJobOptions = {};
    const jma = Number(jobMaxAttempts);
    if (jobMaxAttempts.trim() !== '' && Number.isFinite(jma)) jobOptions.maxAttempts = jma;
    const jb = Number(jobBackoff);
    if (jobBackoff.trim() !== '' && Number.isFinite(jb)) jobOptions.backoff = jb;
    const jt = Number(jobTimeout);
    if (jobTimeout.trim() !== '' && Number.isFinite(jt)) jobOptions.timeout = jt;
    if (Object.keys(jobOptions).length > 0) body.jobOptions = jobOptions;
    setBusy(true);
    try {
      await onCreate(body);
      setName('');
      setSchedule('');
      setEvery('');
      fireCreated();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
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
          <>
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
            {/* Human reading of the raw milliseconds — mirrors the cron-mode next-runs preview. */}
            {every.trim() !== '' && (
              <span
                className={cn('pb-2 text-xs', everyPreview(every) ? 'text-muted' : 'text-danger')}
              >
                {everyPreview(every) ?? 'not a valid interval'}
              </span>
            )}
          </>
        )}
      </div>
      {mode === 'cron' && schedule.trim() && preview && (
        <div className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-xs">
          {preview.valid ? (
            preview.runs.length ? (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-faint">Next runs{timezone.trim() ? ' (local)' : ''}:</span>
                {preview.runs.map((r) => (
                  <span key={r} className="font-mono text-muted">
                    {formatDateTime(r)}
                  </span>
                ))}
                {timezone.trim() && (
                  <span className="text-faint">— server evaluates in {timezone.trim()}</span>
                )}
              </div>
            ) : (
              <span className="text-warning">Valid, but no runs in the next few years.</span>
            )
          ) : (
            <span className="text-danger">{preview.error}</span>
          )}
        </div>
      )}
      <Field label="Data (JSON)">
        {/* Raw textarea (no ui-kit Textarea exists): same control styling as Input. */}
        <textarea
          value={dataText}
          onChange={(e) => setDataText(e.target.value)}
          rows={3}
          spellCheck={false}
          className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-sm text-fg placeholder:text-faint transition-colors focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/30"
        />
      </Field>
      <div>
        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          className="text-xs font-medium text-muted hover:text-fg"
        >
          {showAdvanced ? '− Hide advanced' : '+ Advanced options'}
        </button>
        {showAdvanced && (
          <div className="mt-3 grid grid-cols-2 gap-3">
            <Field label="Timezone (IANA)" hint="e.g. Europe/Rome. Default: server timezone.">
              <Input
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                placeholder="Europe/Rome"
              />
            </Field>
            <Field label="Priority">
              <Input
                type="number"
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                placeholder="0"
              />
            </Field>
            <Field label="Max executions" hint="blank = unlimited">
              <Input
                type="number"
                min={1}
                value={maxLimit}
                onChange={(e) => setMaxLimit(e.target.value)}
                placeholder="∞"
              />
            </Field>
            <div className="col-span-2 flex flex-wrap gap-6">
              <div className="flex items-center gap-2">
                <Toggle
                  checked={preventOverlap}
                  onChange={setPreventOverlap}
                  label="prevent overlap"
                />
                <span className="text-sm text-muted">prevent overlap</span>
              </div>
              <div className="flex items-center gap-2">
                <Toggle
                  checked={skipIfNoWorker}
                  onChange={setSkipIfNoWorker}
                  label="skip if no worker"
                />
                <span className="text-sm text-muted">skip if no worker</span>
              </div>
              <div className="flex items-center gap-2">
                <Toggle checked={immediately} onChange={setImmediately} label="run immediately" />
                <span className="text-sm text-muted">run immediately</span>
              </div>
              <div className="flex items-center gap-2">
                <Toggle
                  checked={skipMissedOnRestart}
                  onChange={setSkipMissedOnRestart}
                  label="skip missed on restart"
                />
                <span className="text-sm text-muted">skip missed on restart</span>
              </div>
            </div>
            <div className="col-span-2">
              <div className="mb-2 text-[11px] uppercase tracking-wider text-faint">
                Spawned-job options
              </div>
              <div className="grid grid-cols-3 gap-3">
                <Field label="Max attempts">
                  <Input
                    type="number"
                    min={1}
                    value={jobMaxAttempts}
                    onChange={(e) => setJobMaxAttempts(e.target.value)}
                    placeholder="3"
                  />
                </Field>
                <Field label="Backoff (ms)">
                  <Input
                    type="number"
                    min={0}
                    value={jobBackoff}
                    onChange={(e) => setJobBackoff(e.target.value)}
                    placeholder="1000"
                  />
                </Field>
                <Field label="Timeout (ms)">
                  <Input
                    type="number"
                    min={0}
                    value={jobTimeout}
                    onChange={(e) => setJobTimeout(e.target.value)}
                    placeholder="—"
                  />
                </Field>
              </div>
            </div>
          </div>
        )}
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" variant="accent" size="sm" disabled={busy}>
          {busy ? 'Creating…' : 'Create'}
        </Button>
        {err && (
          <span role="status" className="text-xs text-danger">
            {err}
          </span>
        )}
        {created && (
          <span role="status" className="text-xs text-success">
            Cron created ✓
          </span>
        )}
      </div>
    </form>
  );
}
