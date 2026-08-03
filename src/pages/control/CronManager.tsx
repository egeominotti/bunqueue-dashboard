import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from '@/components/dashboard/stores/toastStore';
import { Button, IconButton } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { EmptyState, ErrorState, LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { Field, Input, SegmentedControl, Toggle } from '@/components/ui/form';
import { IconCron, IconTrash } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { bq, type CreateCronBody, type CronJobOptions } from '@/lib/bq';
import { cn } from '@/lib/cn';
import { nextCronRuns } from '@/lib/cronPreview';
import { formatDateTime, formatNumber } from '@/lib/format';
import { decodedHttpPathError } from '@/lib/upstreamPaths';
import { usePolledData } from '@/lib/usePolledData';
import { type ServerActionLease, useServerActionGuard } from '@/lib/useServerActionGuard';
import { MAX_JOB_DATA_CHARS, parseJobData, queueNameError } from './AddJob';

const MAX_DELAY_MS = 365 * 24 * 60 * 60 * 1000;
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;

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
  const existingNames = useMemo(() => new Set(crons.map((cron) => cron.name)), [crons]);
  const PAGE_SIZE = 15;
  const pageCount = Math.max(1, Math.ceil(crons.length / PAGE_SIZE));
  const [safePage, setPage] = useClampedPage(pageCount);

  const [actErr, setActErr] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Set<string>>(new Set());
  const actionGuard = useServerActionGuard('cron-manager');
  // biome-ignore lint/correctness/useExhaustiveDependencies: scopeKey is the connection lifecycle boundary
  useEffect(() => {
    setActErr(null);
    setRemoving(new Set());
  }, [actionGuard.scopeKey]);
  const remove = async (name: string) => {
    if (
      !window.confirm(
        `Delete cron "${name}"? It will not be recreated automatically; creating a replacement is a separate action.`
      )
    )
      return;
    const lease = actionGuard.begin(`cron:${name}`);
    if (!lease) return;
    setActErr(null);
    setRemoving((current) => new Set(current).add(name));
    try {
      assertCronDeleteResponse(await bq.deleteCron(name));
      if (!lease.isCurrent()) return;
      toast.success('Cron deleted', name);
      refetch();
    } catch (e) {
      if (!lease.isCurrent()) return;
      // A confirmed delete that silently no-ops reads as "it worked" — say why.
      setActErr((e as Error).message);
      toast.error('Delete cron failed', (e as Error).message);
    } finally {
      if (lease.finish()) {
        setRemoving((current) => {
          const next = new Set(current);
          next.delete(name);
          return next;
        });
      }
    }
  };

  return (
    <div>
      {error && data && (
        <OfflineBanner
          message="Cron refresh failed — showing the last successful schedule list."
          onRetry={refetch}
        />
      )}
      <PageHeader
        title="Cron Manager"
        description="Submit explicitly acknowledged schedule upserts and manage repeatable jobs."
        live={!!data && !error}
      />
      {actErr && (
        <div
          role="status"
          className="mb-4 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-2 text-sm text-danger"
        >
          {actErr}
        </div>
      )}

      <Card className="mb-6">
        <CardHeader title="Create schedule via upstream upsert" />
        <CronForm
          existingNames={existingNames}
          onCreate={async (body, isCurrent) => {
            // v2.8.55 POST /crons is an upsert, not create-only. Recheck as
            // close as possible to the mutation so a stale poll cannot make
            // this form overwrite an existing definition's hidden fields.
            const latest = await bq.crons();
            // The preflight is a separate request. Never let a target change
            // between it and the upsert redirect the write to another server.
            if (!isCurrent()) throw new Error('Cron creation target changed during preflight');
            assertCronNameAvailable(latest, body.name);
            return bq.createCron(body);
          }}
          onAccepted={refetch}
          beginCreate={(name) => actionGuard.begin(`cron:${name}`)}
          scopeKey={actionGuard.scopeKey}
        />
      </Card>

      {error && !data ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : loading && !data ? (
        <LoadingState label="Loading crons…" />
      ) : crons.length === 0 ? (
        <EmptyState icon={<IconCron />} title="No scheduled jobs" hint="Submit one above." />
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
                      <IconButton
                        aria-label={`Delete cron ${c.name}`}
                        disabled={removing.has(c.name)}
                        onClick={() => remove(c.name)}
                      >
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

export function assertCronDeleteResponse(response: unknown): void {
  if (
    response == null ||
    typeof response !== 'object' ||
    (response as { ok?: unknown }).ok !== true
  ) {
    throw new Error('Delete cron returned a malformed success response');
  }
}

export function assertCronCreateResponse(response: unknown, expected: CreateCronBody): void {
  const cron = (response as { cron?: unknown } | null)?.cron;
  if (
    response == null ||
    typeof response !== 'object' ||
    (response as { ok?: unknown }).ok !== true ||
    cron == null ||
    typeof cron !== 'object' ||
    (cron as { name?: unknown }).name !== expected.name ||
    (cron as { queue?: unknown }).queue !== expected.queue
  ) {
    throw new Error('Create cron returned a malformed success response');
  }
}

const cronAlreadyExistsMessage = (name: string) =>
  `Cron "${name}" already exists. Bunqueue v2.8.55 does not return complete cron definitions, so editing could reset hidden options. Delete it explicitly, wait for the list to refresh, then create the replacement as a separate action.`;

export function existingCronNameError(
  name: string,
  existingNames: ReadonlySet<string>
): string | null {
  const normalized = name.trim();
  return normalized && existingNames.has(normalized) ? cronAlreadyExistsMessage(normalized) : null;
}

/** Fail closed before a POST /crons upsert if the live list cannot prove the name is unused. */
export function assertCronNameAvailable(response: unknown, expectedName: string): void {
  const envelope = response as { ok?: unknown; crons?: unknown } | null;
  if (
    envelope == null ||
    typeof envelope !== 'object' ||
    envelope.ok !== true ||
    !Array.isArray(envelope.crons) ||
    envelope.crons.some(
      (cron) =>
        cron == null ||
        typeof cron !== 'object' ||
        typeof (cron as { name?: unknown }).name !== 'string'
    )
  ) {
    throw new Error('Cannot verify that the cron name is unused; creation was not attempted');
  }
  if (envelope.crons.some((cron) => (cron as { name: string }).name === expectedName.trim())) {
    throw new Error(cronAlreadyExistsMessage(expectedName.trim()));
  }
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

export interface CronFormValues {
  name: string;
  queue: string;
  mode: 'cron' | 'every';
  schedule: string;
  every: string;
  dataText: string;
  timezone: string;
  priority: string;
  preventOverlap: boolean;
  skipIfNoWorker: boolean;
  maxLimit: string;
  immediately: boolean;
  skipMissedOnRestart: boolean;
  uniqueKey: string;
  dedupTtl: string;
  dedupExtend: boolean;
  dedupReplace: boolean;
  jobMaxAttempts: string;
  jobBackoff: string;
  jobTimeout: string;
  jobDelay: string;
  jobStallTimeout: string;
  jobRemoveOnComplete: boolean;
  jobRemoveOnFail: boolean;
}

function parseOptionalWhole(
  raw: string,
  label: string,
  min: number,
  max: number
): { ok: true; value?: number } | { ok: false; msg: string } {
  if (!raw.trim()) return { ok: true };
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    return { ok: false, msg: `${label} must be a whole number from ${min} to ${max}` };
  }
  return { ok: true, value };
}

/** Build a cron definition while leaving expression validation to Bunqueue. */
export function buildCronBody(
  values: CronFormValues,
  now = Date.now()
): { ok: true; body: CreateCronBody } | { ok: false; msg: string } {
  const name = values.name.trim();
  const queue = values.queue.trim();
  if (!name) return { ok: false, msg: 'Name is required' };
  if (name.length > 256) return { ok: false, msg: 'Name must be 256 characters or fewer' };
  const invalidName = decodedHttpPathError(name, 'Name', 256);
  if (invalidName) return { ok: false, msg: invalidName };
  const invalidQueue = queueNameError(queue);
  if (invalidQueue) return { ok: false, msg: invalidQueue };

  let data: unknown = {};
  if (values.dataText.trim()) {
    // Share AddJob's allocation-free, pre-parse UTF-8/UTF-16 budget. Measuring
    // only after JSON.parse lets hostile inputs allocate an unbounded graph and
    // under-counts non-ASCII request bytes.
    const parsed = parseJobData(values.dataText);
    if (!parsed.ok) {
      return {
        ok: false,
        msg: parsed.kind === 'json' ? 'Data is not valid JSON' : parsed.msg,
      };
    }
    data = parsed.data;
  }

  const body: CreateCronBody = {
    name,
    queue,
    data,
    preventOverlap: values.preventOverlap,
    skipIfNoWorker: values.skipIfNoWorker,
    immediately: values.immediately,
    skipMissedOnRestart: values.skipMissedOnRestart,
  };
  if (values.mode === 'cron') {
    const schedule = values.schedule.trim();
    if (!schedule) return { ok: false, msg: 'Cron expression required' };
    // The local preview intentionally implements only five-field cron. Croner,
    // used by v2.8.55, also accepts six fields and shortcuts such as @hourly.
    // Rejecting on preview failure would therefore block valid server input.
    body.schedule = schedule;
  } else {
    const interval = parseOptionalWhole(values.every, 'Interval', 1, MAX_DELAY_MS);
    if (!interval.ok || interval.value === undefined) {
      return {
        ok: false,
        msg: interval.ok ? 'Interval is required' : interval.msg,
      };
    }
    body.repeatEvery = interval.value;
  }

  const timezone = values.timezone.trim();
  if (timezone) {
    if (values.mode !== 'cron') {
      return { ok: false, msg: 'Timezone applies only to cron expressions, not intervals' };
    }
    try {
      new Intl.DateTimeFormat('en', { timeZone: timezone }).format(now);
    } catch {
      return { ok: false, msg: 'Timezone must be a valid IANA timezone' };
    }
    body.timezone = timezone;
  }

  const priority = parseOptionalWhole(values.priority, 'Priority', -1_000_000, 1_000_000);
  if (!priority.ok) return priority;
  if (priority.value !== undefined) body.priority = priority.value;
  const maxLimit = parseOptionalWhole(
    values.maxLimit,
    'Max executions',
    1,
    Number.MAX_SAFE_INTEGER
  );
  if (!maxLimit.ok) return maxLimit;
  if (maxLimit.value !== undefined) body.maxLimit = maxLimit.value;

  const uniqueKey = values.uniqueKey.trim();
  if (uniqueKey.length > 1024) {
    return { ok: false, msg: 'Unique key must be 1024 characters or fewer' };
  }
  if (uniqueKey) body.uniqueKey = uniqueKey;
  const dedupTtl = parseOptionalWhole(values.dedupTtl, 'Dedup TTL', 1, MAX_DELAY_MS);
  if (!dedupTtl.ok) return dedupTtl;
  const hasDedup = dedupTtl.value !== undefined || values.dedupExtend || values.dedupReplace;
  if (values.dedupExtend && values.dedupReplace) {
    return { ok: false, msg: 'Dedup extend and replace are mutually exclusive' };
  }
  if (values.dedupExtend && dedupTtl.value === undefined) {
    return { ok: false, msg: 'Dedup extend requires a TTL' };
  }
  if (hasDedup && !uniqueKey && !values.preventOverlap) {
    return { ok: false, msg: 'Dedup options require a unique key or Prevent overlap' };
  }
  if (hasDedup) {
    body.dedup = {
      ...(dedupTtl.value !== undefined ? { ttl: dedupTtl.value } : {}),
      ...(values.dedupExtend ? { extend: true } : {}),
      ...(values.dedupReplace ? { replace: true } : {}),
    };
  }

  const jobChecks: Array<{
    raw: string;
    label: string;
    min: number;
    max: number;
    key: keyof Pick<
      CronJobOptions,
      'maxAttempts' | 'backoff' | 'timeout' | 'delay' | 'stallTimeout'
    >;
  }> = [
    {
      raw: values.jobMaxAttempts,
      label: 'Spawned-job max attempts',
      min: 1,
      max: 1000,
      key: 'maxAttempts',
    },
    {
      raw: values.jobBackoff,
      label: 'Spawned-job backoff',
      min: 0,
      max: MAX_DURATION_MS,
      key: 'backoff',
    },
    {
      raw: values.jobTimeout,
      label: 'Spawned-job timeout',
      min: 0,
      max: MAX_DURATION_MS,
      key: 'timeout',
    },
    { raw: values.jobDelay, label: 'Spawned-job delay', min: 0, max: MAX_DELAY_MS, key: 'delay' },
    {
      raw: values.jobStallTimeout,
      label: 'Spawned-job stall timeout',
      min: 0,
      max: MAX_DURATION_MS,
      key: 'stallTimeout',
    },
  ];
  const jobOptions: CronJobOptions = {};
  for (const check of jobChecks) {
    const parsed = parseOptionalWhole(check.raw, check.label, check.min, check.max);
    if (!parsed.ok) return parsed;
    if (parsed.value !== undefined) jobOptions[check.key] = parsed.value;
  }
  if (values.jobRemoveOnComplete) jobOptions.removeOnComplete = true;
  if (values.jobRemoveOnFail) jobOptions.removeOnFail = true;
  if (Object.keys(jobOptions).length) body.jobOptions = jobOptions;
  return { ok: true, body };
}

function CronForm({
  onCreate,
  onAccepted,
  beginCreate,
  scopeKey,
  existingNames,
}: {
  onCreate: (b: CreateCronBody, isCurrent: () => boolean) => Promise<unknown>;
  onAccepted: () => void;
  beginCreate: (name: string) => ServerActionLease | null;
  scopeKey: string;
  existingNames: ReadonlySet<string>;
}) {
  const [name, setName] = useState('');
  const [queue, setQueue] = useState('');
  const [mode, setMode] = useState<'cron' | 'every'>('cron');
  const [schedule, setSchedule] = useState('');
  const [every, setEvery] = useState('');
  const [dataText, setDataText] = useState('{}');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [timezone, setTimezone] = useState('');
  const [priority, setPriority] = useState('');
  // Mirrors v2.8.55 defaults; always submit these booleans so the rendered
  // switches and the stored schedule cannot disagree.
  const [preventOverlap, setPreventOverlap] = useState(true);
  const [skipIfNoWorker, setSkipIfNoWorker] = useState(false);
  const [maxLimit, setMaxLimit] = useState('');
  const [immediately, setImmediately] = useState(false);
  const [skipMissedOnRestart, setSkipMissedOnRestart] = useState(true);
  const [uniqueKey, setUniqueKey] = useState('');
  const [dedupTtl, setDedupTtl] = useState('');
  const [dedupExtend, setDedupExtend] = useState(false);
  const [dedupReplace, setDedupReplace] = useState(false);
  const [jobMaxAttempts, setJobMaxAttempts] = useState('');
  const [jobBackoff, setJobBackoff] = useState('');
  const [jobTimeout, setJobTimeout] = useState('');
  const [jobDelay, setJobDelay] = useState('');
  const [jobStallTimeout, setJobStallTimeout] = useState('');
  const [jobRemoveOnComplete, setJobRemoveOnComplete] = useState(false);
  const [jobRemoveOnFail, setJobRemoveOnFail] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { on: created, fire: fireCreated, reset: resetCreated } = useTransientFlag(3000);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scopeKey is the lifecycle boundary
  useEffect(() => {
    setBusy(false);
    setErr(null);
    resetCreated();
  }, [scopeKey]);

  // Live preview of the next fire times so a typo (9 0 * * * vs 0 9 * * *) is
  // caught before the schedule is created. Computed in the browser's local
  // timezone; a server-side timezone is noted separately.
  const preview = useMemo(() => {
    if (mode !== 'cron' || !schedule.trim()) return null;
    return nextCronRuns(schedule.trim(), 3, Date.now());
  }, [mode, schedule]);
  const nameConflict = existingCronNameError(name, existingNames);

  const submit = async () => {
    setErr(null);
    resetCreated();
    const built = buildCronBody({
      name,
      queue,
      mode,
      schedule,
      every,
      dataText,
      timezone,
      priority,
      preventOverlap,
      skipIfNoWorker,
      maxLimit,
      immediately,
      skipMissedOnRestart,
      uniqueKey,
      dedupTtl,
      dedupExtend,
      dedupReplace,
      jobMaxAttempts,
      jobBackoff,
      jobTimeout,
      jobDelay,
      jobStallTimeout,
      jobRemoveOnComplete,
      jobRemoveOnFail,
    });
    if (!built.ok) {
      setErr(built.msg);
      return;
    }
    const body = built.body;
    const conflict = existingCronNameError(body.name, existingNames);
    if (conflict) {
      setErr(conflict);
      return;
    }
    if (
      !window.confirm(
        `Submit an upsert for cron "${body.name}"? Bunqueue v2.8.55 has no atomic create-only condition. The dashboard will recheck immediately before writing, but another client using the same name at the same time could still be replaced. Continue only if you authorize last-writer-wins behavior for this globally unique name.`
      )
    )
      return;
    const lease = beginCreate(body.name);
    if (!lease) return;
    setBusy(true);
    try {
      const response = await onCreate(body, lease.isCurrent);
      assertCronCreateResponse(response, body);
      if (!lease.isCurrent()) return;
      setName('');
      setSchedule('');
      setEvery('');
      fireCreated();
      toast.success('Cron upsert acknowledged', body.name);
      onAccepted();
    } catch (e) {
      if (!lease.isCurrent()) return;
      setErr((e as Error).message);
    } finally {
      if (lease.finish()) setBusy(false);
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
            name="cron-name"
            autoComplete="off"
            maxLength={256}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="daily-report"
          />
        </Field>
        <Field label="Queue">
          <Input
            name="cron-queue"
            autoComplete="off"
            maxLength={256}
            value={queue}
            onChange={(e) => setQueue(e.target.value)}
            placeholder="reports"
          />
        </Field>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <fieldset>
          <legend className="sr-only">Schedule type</legend>
          <SegmentedControl options={['cron', 'every'] as const} value={mode} onChange={setMode} />
        </fieldset>
        {mode === 'cron' ? (
          <div className="min-w-56 flex-1">
            <Field label="Cron expression">
              <Input
                name="cron-expression"
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
                  min={1}
                  max={MAX_DELAY_MS}
                  step={1}
                  name="cron-interval"
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
            <span className="text-warning">
              Preview unavailable: {preview.error} Bunqueue will validate this expression when you
              create the schedule.
            </span>
          )}
        </div>
      )}
      <Field label="Data (JSON)">
        {/* Raw textarea (no ui-kit Textarea exists): same control styling as Input. */}
        <textarea
          name="cron-data"
          value={dataText}
          onChange={(e) => setDataText(e.target.value)}
          maxLength={MAX_JOB_DATA_CHARS}
          rows={3}
          spellCheck={false}
          className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-sm text-fg placeholder:text-faint transition-colors focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/30"
        />
      </Field>
      <div>
        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          aria-expanded={showAdvanced}
          aria-controls="cron-advanced-options"
          className="text-xs font-medium text-muted hover:text-fg"
        >
          {showAdvanced ? '− Hide advanced' : '+ Advanced options'}
        </button>
        {showAdvanced && (
          <div id="cron-advanced-options" className="mt-3 grid grid-cols-2 gap-3">
            <Field label="Timezone (IANA)" hint="e.g. Europe/Rome. Default: server timezone.">
              <Input
                name="cron-timezone"
                autoComplete="off"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                placeholder="Europe/Rome"
              />
            </Field>
            <Field label="Priority">
              <Input
                type="number"
                min={-1_000_000}
                max={1_000_000}
                step={1}
                name="cron-priority"
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                placeholder="0"
              />
            </Field>
            <Field label="Max executions" hint="blank = unlimited">
              <Input
                type="number"
                min={1}
                max={Number.MAX_SAFE_INTEGER}
                step={1}
                name="cron-max-executions"
                value={maxLimit}
                onChange={(e) => setMaxLimit(e.target.value)}
                placeholder="∞"
              />
            </Field>
            <Field label="Unique key" hint="optional deduplication key">
              <Input
                name="cron-unique-key"
                autoComplete="off"
                maxLength={1024}
                value={uniqueKey}
                onChange={(e) => setUniqueKey(e.target.value)}
                placeholder="daily-report"
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
                Cron deduplication
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Field label="Dedup TTL (ms)" hint="blank = no TTL">
                  <Input
                    type="number"
                    min={1}
                    max={MAX_DELAY_MS}
                    step={1}
                    name="cron-dedup-ttl"
                    value={dedupTtl}
                    onChange={(e) => setDedupTtl(e.target.value)}
                    placeholder="60000"
                  />
                </Field>
                <div className="flex items-end gap-2 pb-2">
                  <Toggle
                    checked={dedupExtend}
                    onChange={setDedupExtend}
                    label="extend dedup TTL"
                  />
                  <span className="text-sm text-muted">extend TTL</span>
                </div>
                <div className="flex items-end gap-2 pb-2">
                  <Toggle
                    checked={dedupReplace}
                    onChange={setDedupReplace}
                    label="replace duplicate"
                  />
                  <span className="text-sm text-muted">replace duplicate</span>
                </div>
              </div>
            </div>
            <div className="col-span-2">
              <div className="mb-2 text-[11px] uppercase tracking-wider text-faint">
                Spawned-job options
              </div>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
                <Field label="Max attempts">
                  <Input
                    type="number"
                    min={1}
                    max={1000}
                    step={1}
                    name="cron-job-max-attempts"
                    value={jobMaxAttempts}
                    onChange={(e) => setJobMaxAttempts(e.target.value)}
                    placeholder="3"
                  />
                </Field>
                <Field label="Backoff (ms)">
                  <Input
                    type="number"
                    min={0}
                    max={MAX_DURATION_MS}
                    step={1}
                    name="cron-job-backoff"
                    value={jobBackoff}
                    onChange={(e) => setJobBackoff(e.target.value)}
                    placeholder="1000"
                  />
                </Field>
                <Field label="Timeout (ms)">
                  <Input
                    type="number"
                    min={0}
                    max={MAX_DURATION_MS}
                    step={1}
                    name="cron-job-timeout"
                    value={jobTimeout}
                    onChange={(e) => setJobTimeout(e.target.value)}
                    placeholder="—"
                  />
                </Field>
                <Field label="Delay (ms)">
                  <Input
                    type="number"
                    min={0}
                    max={MAX_DELAY_MS}
                    step={1}
                    name="cron-job-delay"
                    value={jobDelay}
                    onChange={(e) => setJobDelay(e.target.value)}
                    placeholder="0"
                  />
                </Field>
                <Field label="Stall timeout (ms)">
                  <Input
                    type="number"
                    min={0}
                    max={MAX_DURATION_MS}
                    step={1}
                    name="cron-job-stall-timeout"
                    value={jobStallTimeout}
                    onChange={(e) => setJobStallTimeout(e.target.value)}
                    placeholder="server default"
                  />
                </Field>
              </div>
              <div className="mt-3 flex flex-wrap gap-6">
                <div className="flex items-center gap-2">
                  <Toggle
                    checked={jobRemoveOnComplete}
                    onChange={setJobRemoveOnComplete}
                    label="remove spawned jobs on complete"
                  />
                  <span className="text-sm text-muted">remove on complete</span>
                </div>
                <div className="flex items-center gap-2">
                  <Toggle
                    checked={jobRemoveOnFail}
                    onChange={setJobRemoveOnFail}
                    label="remove spawned jobs on fail"
                  />
                  <span className="text-sm text-muted">remove on fail</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" variant="accent" size="sm" disabled={busy || !!nameConflict}>
          {busy ? 'Saving…' : nameConflict ? 'Name already exists' : 'Submit upsert'}
        </Button>
        {nameConflict && !err && (
          <span role="alert" className="max-w-2xl text-xs text-warning">
            {nameConflict}
          </span>
        )}
        {err && (
          <span role="alert" className="text-xs text-danger">
            {err}
          </span>
        )}
        {created && (
          <span role="status" className="text-xs text-success">
            Cron upsert acknowledged ✓
          </span>
        )}
      </div>
      <p className="text-xs text-warning">
        Creation is an upstream upsert, not an atomic create-only operation. Use a globally unique
        name; the fail-closed preflight cannot eliminate a simultaneous write from another client.
      </p>
    </form>
  );
}
