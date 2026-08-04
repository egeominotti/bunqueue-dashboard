import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { toast } from '@/components/dashboard/stores/toastStore';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Field, Input, Select, Toggle } from '@/components/ui/form';
import { PageHeader } from '@/components/ui/PageHeader';
import {
  type AddJobBody,
  type Backoff,
  bq,
  bulkJobPayloadBudgetError,
  type RepeatOptions,
} from '@/lib/bq';
import type { CloneJobState } from '@/lib/cloneJob';
import { opaqueHttpIdError, queueHttpPathError } from '@/lib/upstreamPaths';
import { usePolledData } from '@/lib/usePolledData';
import { useServerActionGuard } from '@/lib/useServerActionGuard';

const numOrEmpty = (v: number | undefined): string => (v == null ? '' : String(v));

const MAX_DELAY_MS = 365 * 24 * 60 * 60 * 1000;
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
export const MAX_JOB_DATA_CHARS = 10 * 1024 * 1024;
export const MAX_JOB_DATA_BYTES = 10 * 1024 * 1024;

/**
 * Count a JavaScript string as UTF-8 without allocating a second, encoded copy.
 * `stopAfter` lets callers reject hostile input as soon as it crosses a budget.
 * Lone surrogates match TextEncoder/JSON transport semantics (U+FFFD = 3 bytes).
 */
export function utf8ByteLength(text: string, stopAfter = Number.POSITIVE_INFINITY): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit <= 0x7f) {
      bytes += 1;
    } else if (unit <= 0x7ff) {
      bytes += 2;
    } else if (
      unit >= 0xd800 &&
      unit <= 0xdbff &&
      index + 1 < text.length &&
      text.charCodeAt(index + 1) >= 0xdc00 &&
      text.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
    if (bytes > stopAfter) return bytes;
  }
  return bytes;
}

function jobDataBudgetError(text: string): string | null {
  // Check the O(1) UTF-16 length first. The UTF-8 walk is still allocation-free
  // and happens before JSON.parse/JSON.stringify can create large object graphs
  // or normalized copies.
  if (
    text.length > MAX_JOB_DATA_CHARS ||
    utf8ByteLength(text, MAX_JOB_DATA_BYTES) > MAX_JOB_DATA_BYTES
  ) {
    return 'Job data is too large (maximum 10 MiB UTF-8 / 10,485,760 characters)';
  }
  return null;
}

export function parseJobData(
  text: string
): { ok: true; data: unknown } | { ok: false; kind: 'json' | 'size'; msg: string } {
  const inputBudgetError = jobDataBudgetError(text);
  if (inputBudgetError) return { ok: false, kind: 'size', msg: inputBudgetError };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, kind: 'json', msg: `Invalid JSON: ${(error as Error).message}` };
  }

  // Measure the exact compact representation sent by fetch. The raw input was
  // already bounded before this stringify, so this cannot amplify unboundedly.
  const encoded = JSON.stringify(parsed);
  if (
    encoded.length > MAX_JOB_DATA_CHARS ||
    utf8ByteLength(encoded, MAX_JOB_DATA_BYTES) > MAX_JOB_DATA_BYTES
  ) {
    return {
      ok: false,
      kind: 'size',
      msg: 'Job data is too large after JSON encoding (maximum 10 MiB UTF-8)',
    };
  }
  return { ok: true, data: parsed };
}

interface AddJobNumericInput {
  priority: string;
  delay: string;
  maxAttempts: string;
  backoff: string;
  timeout: string;
  ttl?: string;
}

interface AddJobNumericOptions {
  priority?: number;
  delay?: number;
  maxAttempts?: number;
  backoff?: number;
  timeout?: number;
  ttl?: number;
}

/** Mirror the numeric bounds enforced by bunqueue v2.8.57's PUSH validator. */
export function parseAddJobNumbers(
  raw: AddJobNumericInput
): { ok: true; options: AddJobNumericOptions } | { ok: false; msg: string } {
  const rules: Array<{
    key: keyof AddJobNumericInput;
    label: string;
    min: number;
    max: number;
    integer: boolean;
  }> = [
    { key: 'priority', label: 'Priority', min: -1_000_000, max: 1_000_000, integer: true },
    { key: 'delay', label: 'Delay', min: 0, max: MAX_DELAY_MS, integer: true },
    { key: 'maxAttempts', label: 'Max attempts', min: 1, max: 1000, integer: true },
    { key: 'backoff', label: 'Backoff', min: 0, max: MAX_DURATION_MS, integer: true },
    { key: 'timeout', label: 'Timeout', min: 0, max: MAX_DURATION_MS, integer: true },
    { key: 'ttl', label: 'TTL', min: 0, max: MAX_DELAY_MS, integer: true },
  ];
  const options: AddJobNumericOptions = {};
  for (const rule of rules) {
    const text = (raw[rule.key] ?? '').trim();
    if (!text) continue;
    const value = Number(text);
    if (!Number.isFinite(value)) return { ok: false, msg: `${rule.label} must be a number` };
    if (rule.integer && !Number.isSafeInteger(value)) {
      return { ok: false, msg: `${rule.label} must be a whole, safe integer` };
    }
    if (value < rule.min || value > rule.max) {
      return {
        ok: false,
        msg: `${rule.label} must be between ${rule.min} and ${rule.max}`,
      };
    }
    options[rule.key] = value;
  }
  return { ok: true, options };
}

/** Queue names use the same grammar and length enforced by v2.8.57. */
export function queueNameError(queue: string): string | null {
  const error = queueHttpPathError(queue);
  return !queue && error ? 'Choose a queue' : error;
}

/**
 * A strategy is only transmissible with a base delay (the API takes
 * `{ type, delay }`), so a strategy picked without one is reported, never
 * silently dropped.
 */
export function resolveBackoff(
  delayMs: number | undefined,
  type: '' | 'fixed' | 'exponential'
): { ok: true; backoff: Backoff | undefined } | { ok: false; msg: string } {
  if (delayMs == null) {
    return type
      ? { ok: false, msg: 'Backoff strategy needs a base delay in Backoff (ms)' }
      : { ok: true, backoff: undefined };
  }
  return { ok: true, backoff: type ? { type, delay: delayMs } : delayMs };
}

/**
 * PUSHB returns one id per accepted submission, but an id may belong to an
 * existing customId/uniqueKey job. Distinct ids therefore describe the reply;
 * they are never evidence that the server persisted that many new jobs.
 */
export function createdSummary(
  distinctIds: number,
  submitted: number
): { ok: boolean; msg: string } {
  return {
    ok: true,
    msg: `Accepted ${submitted} job submission${submitted === 1 ? '' : 's'}; server returned ${distinctIds} distinct job ID${distinctIds === 1 ? '' : 's'} (deduplication may reuse existing jobs)`,
  };
}

export function acceptedJobId(response: unknown): string {
  if (
    response == null ||
    typeof response !== 'object' ||
    (response as { ok?: unknown }).ok !== true ||
    typeof (response as { id?: unknown }).id !== 'string' ||
    !(response as { id: string }).id ||
    (response as { id: string }).id.length > 1024
  ) {
    throw new Error('Add job returned a malformed success response');
  }
  return (response as { id: string }).id;
}

export function acceptedBulkIds(response: unknown, submitted: number): string[] {
  const ids = (response as { ids?: unknown } | null)?.ids;
  if (
    response == null ||
    typeof response !== 'object' ||
    (response as { ok?: unknown }).ok !== true ||
    !Array.isArray(ids) ||
    ids.length !== submitted ||
    ids.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 1024)
  ) {
    throw new Error('Bulk add returned a malformed success response');
  }
  return ids as string[];
}

/**
 * Parse the optional repeat policy accepted by the v2.8.57 HTTP push route.
 * Pattern repeats are deliberately refused: that release stores `pattern` but
 * schedules the next job with `every ?? 0`, which can create an immediate hot
 * loop instead of executing the requested cron expression.
 */
export function parseRepeat(
  text: string
): { ok: true; repeat: RepeatOptions | undefined } | { ok: false; msg: string } {
  if (!text.trim()) return { ok: true, repeat: undefined };
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, msg: 'Repeat must be a JSON object' };
    }
    const raw = parsed as Record<string, unknown>;
    // v2.8.57's server-side repeat continuation preserves only `every`,
    // `limit`, `pattern`, and its internal count. Expose only the two options it
    // executes faithfully; accepting the other public-client fields here would
    // imply behavior the HTTP/server path silently loses after the first run.
    const allowed = new Set(['every', 'limit', 'pattern']);
    const unknown = Object.keys(raw).filter((key) => !allowed.has(key));
    if (unknown.length) {
      return {
        ok: false,
        msg: `Unknown repeat option${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`,
      };
    }
    if (raw.pattern !== undefined) {
      return {
        ok: false,
        msg: 'repeat.pattern is unsafe in bunqueue v2.8.57; use repeat.every or a Cron schedule',
      };
    }
    const every = raw.every;
    if (
      !Number.isSafeInteger(every) ||
      (every as number) <= 0 ||
      (every as number) > MAX_DELAY_MS
    ) {
      return {
        ok: false,
        msg: `Repeat "every" must be a whole number from 1 to ${MAX_DELAY_MS} ms`,
      };
    }
    if (
      raw.limit !== undefined &&
      (!Number.isSafeInteger(raw.limit) || (raw.limit as number) < 1)
    ) {
      return { ok: false, msg: 'Repeat "limit" must be a whole number of at least 1' };
    }
    const repeat: RepeatOptions = {
      every: every as number,
      ...(typeof raw.limit === 'number' ? { limit: raw.limit } : {}),
    };
    return { ok: true, repeat };
  } catch (e) {
    return { ok: false, msg: `Repeat is not valid JSON: ${(e as Error).message}` };
  }
}

type CloneOptions = CloneJobState['clone']['options'];

export interface AddJobCloneDefaults {
  backoff: string;
  backoffType: '' | 'fixed' | 'exponential';
  tags: string;
  groupId: string;
  ttl: string;
}

/**
 * Convert clone router state into the exact strings bound by the Add Job form.
 * A structured backoff owns both its strategy and delay; using a stale flat
 * `backoff` value alongside it would silently change the cloned retry policy.
 */
export function addJobCloneDefaults(options: CloneOptions): AddJobCloneDefaults {
  // Accept both the dashboard's explicit clone metadata and a structured
  // AddJobBody.backoff supplied by older/external router state.
  const embeddedConfig = typeof options.backoff === 'object' ? options.backoff : undefined;
  const config = options.backoffConfig ?? embeddedConfig;
  return {
    backoff: numOrEmpty(
      config?.delay ?? (typeof options.backoff === 'number' ? options.backoff : undefined)
    ),
    backoffType: config?.type ?? '',
    tags: options.tags?.join(', ') ?? '',
    groupId: options.groupId ?? '',
    ttl: numOrEmpty(options.ttl),
  };
}

export function AddJob() {
  // Queue name datalist only — rarely changes, so slow-poll it.
  const {
    data: qs,
    error: queueDiscoveryError,
    refetch: refetchQueues,
  } = usePolledData(() => bq.queues(), [], { intervalMs: 30000 });

  // A "Clone" link from the Job Inspector hands us a source job's queue/data/
  // options via router state, so this form opens pre-filled for a fresh enqueue.
  const clone = (useLocation().state as Partial<CloneJobState> | null)?.clone;
  const opts = clone?.options ?? {};
  const cloneDefaults = addJobCloneDefaults(opts);

  const [queue, setQueue] = useState(clone?.queue ?? '');
  const [name, setName] = useState(clone?.name ?? 'default');
  const [dataText, setDataText] = useState(clone?.dataText ?? '{\n  "hello": "world"\n}');
  const [count, setCount] = useState('1');

  const [priority, setPriority] = useState(numOrEmpty(opts.priority));
  const [delay, setDelay] = useState('');
  const [runAt, setRunAt] = useState('');
  const [maxAttempts, setMaxAttempts] = useState(numOrEmpty(opts.maxAttempts));
  const [backoff, setBackoff] = useState(cloneDefaults.backoff);
  const [timeout, setTimeout] = useState(numOrEmpty(opts.timeout));
  const [ttl, setTtl] = useState(cloneDefaults.ttl);
  const [jobId, setJobId] = useState('');
  const [removeOnComplete, setRemoveOnComplete] = useState(opts.removeOnComplete ?? false);
  const [removeOnFail, setRemoveOnFail] = useState(opts.removeOnFail ?? false);
  const [durable, setDurable] = useState(false);
  const [lifo, setLifo] = useState(false);
  // Advanced (honored by the single-push HTTP route).
  const [backoffType, setBackoffType] = useState<'' | 'fixed' | 'exponential'>(
    cloneDefaults.backoffType
  );
  const [tags, setTags] = useState(cloneDefaults.tags);
  const [groupId, setGroupId] = useState(cloneDefaults.groupId);
  const [dependsOn, setDependsOn] = useState('');
  const [uniqueKey, setUniqueKey] = useState('');
  const [repeatText, setRepeatText] = useState('');

  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [jsonErr, setJsonErr] = useState<string | null>(null);
  const actionGuard = useServerActionGuard('add-job');
  // biome-ignore lint/correctness/useExhaustiveDependencies: scopeKey is the connection lifecycle boundary
  useEffect(() => {
    setBusy(false);
    setResult(null);
    setJsonErr(null);
  }, [actionGuard.scopeKey]);

  const submit = async () => {
    setResult(null);
    setJsonErr(null);
    // Validate and submit the SAME string: a pasted trailing space would
    // otherwise enqueue into a look-alike queue nobody consumes.
    const target = queue.trim();
    const invalidQueue = queueNameError(target);
    if (invalidQueue) {
      setResult({ ok: false, msg: invalidQueue });
      return;
    }
    const jobName = name.trim();
    if (!jobName || jobName.length > 256) {
      setResult({
        ok: false,
        msg: 'Job name must be a non-empty string of at most 256 characters',
      });
      return;
    }
    const parsedData = parseJobData(dataText);
    if (!parsedData.ok) {
      if (parsedData.kind === 'json') setJsonErr(parsedData.msg);
      else setResult({ ok: false, msg: parsedData.msg });
      return;
    }
    const parsed = parsedData.data;
    const numeric = parseAddJobNumbers({
      priority,
      delay: runAt.trim() ? '' : delay,
      maxAttempts,
      backoff,
      timeout,
      ttl,
    });
    if (!numeric.ok) {
      setResult({ ok: false, msg: numeric.msg });
      return;
    }
    // "Run at" (absolute wall-clock) wins over the raw "Delay (ms)" field: derive
    // the relative delay the API actually takes from the picked datetime.
    let effectiveDelay = numeric.options.delay;
    if (runAt.trim()) {
      const targetMs = new Date(runAt).getTime();
      if (!Number.isFinite(targetMs)) {
        setResult({ ok: false, msg: 'Run at is not a valid date/time' });
        return;
      }
      effectiveDelay = Math.max(0, targetMs - Date.now());
      if (effectiveDelay > MAX_DELAY_MS) {
        setResult({ ok: false, msg: 'Run at must be within the next 365 days' });
        return;
      }
    }
    const bo = resolveBackoff(numeric.options.backoff, backoffType);
    if (!bo.ok) {
      setResult({ ok: false, msg: bo.msg });
      return;
    }
    const backoff_: Backoff | undefined = bo.backoff;
    const tagList = tags
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const depList = dependsOn
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const requestedJobId = jobId.trim();
    if (requestedJobId) {
      const idError = opaqueHttpIdError(requestedJobId);
      if (idError) {
        setResult({ ok: false, msg: `Job ID: ${idError}` });
        return;
      }
    }
    for (const dependency of depList) {
      const idError = opaqueHttpIdError(dependency);
      if (idError) {
        setResult({ ok: false, msg: `Dependency ID "${dependency}": ${idError}` });
        return;
      }
    }
    const repeat = parseRepeat(repeatText);
    if (!repeat.ok) {
      setResult({ ok: false, msg: repeat.msg });
      return;
    }
    const body: AddJobBody = {
      name: jobName,
      data: parsed,
      priority: numeric.options.priority,
      delay: effectiveDelay,
      maxAttempts: numeric.options.maxAttempts,
      backoff: backoff_,
      timeout: numeric.options.timeout,
      ttl: numeric.options.ttl,
      jobId: requestedJobId || undefined,
      removeOnComplete: removeOnComplete || undefined,
      removeOnFail: removeOnFail || undefined,
      durable: durable || undefined,
      lifo: lifo || undefined,
      tags: tagList.length ? tagList : undefined,
      groupId: groupId.trim() || undefined,
      dependsOn: depList.length ? depList : undefined,
      uniqueKey: uniqueKey.trim() || undefined,
      repeat: repeat.repeat,
    };
    const n = Number(count);
    if (!Number.isSafeInteger(n) || n < 1 || n > 10000) {
      setResult({ ok: false, msg: 'Count must be a whole number from 1 to 10000' });
      return;
    }
    const lease = actionGuard.begin();
    if (!lease) return;
    setBusy(true);
    try {
      if (n === 1) {
        const r = await bq.addJob(target, body);
        const id = acceptedJobId(r);
        if (!lease.isCurrent()) return;
        setResult({
          ok: true,
          msg: `Accepted job ID ${id} (it may be an existing deduplicated job)`,
        });
        toast.success('Job submission accepted', `${target} · ${id}`);
      } else {
        // Allocate only the small reference array, then measure the exact
        // translated transport envelope before bq/fetch can stringify it.
        const bodies = Array.from({ length: n }, () => body);
        const payloadError = bulkJobPayloadBudgetError(bodies);
        if (payloadError) {
          if (lease.isCurrent()) setResult({ ok: false, msg: payloadError });
          return;
        }
        const r = await bq.addJobsBulk(target, bodies);
        const ids = acceptedBulkIds(r, n);
        if (!lease.isCurrent()) return;
        const summary = createdSummary(new Set(ids).size, n);
        setResult(summary);
        toast.success(summary.msg, `in ${target}`);
      }
    } catch (e) {
      if (!lease.isCurrent()) return;
      setResult({ ok: false, msg: (e as Error).message });
      toast.error('Add job failed', (e as Error).message);
    } finally {
      if (lease.finish()) setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Add Job"
        description="Enqueue a job with full options."
        actions={
          <Link
            to="/jobs/bulk-add"
            className="rounded-lg border border-line px-3 py-1.5 text-sm text-muted hover:bg-surface-2 hover:text-fg"
          >
            Bulk import
          </Link>
        }
      />

      {clone && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-accent/30 bg-accent/[0.06] px-4 py-2 text-sm text-accent">
          Pre-filled from an existing job. Review the data and options, then enqueue a fresh job.
        </div>
      )}

      <form
        className="grid grid-cols-1 gap-6 lg:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Card>
          <CardHeader title="Job" />
          <div className="flex flex-col gap-4">
            <Field label="Queue">
              <Input
                list="queue-options"
                aria-label="Queue"
                name="target-queue"
                autoComplete="off"
                value={queue}
                onChange={(e) => setQueue(e.target.value)}
                placeholder="queue name (existing or new)"
              />
              <datalist id="queue-options">
                {(qs?.queues ?? []).map((x) => (
                  <option key={x.name} value={x.name} />
                ))}
              </datalist>
            </Field>
            <Field
              label="Job name"
              hint="Worker routing name in Bunqueue 2.8.57; separate from the JSON payload."
            >
              <Input
                name="job-name"
                autoComplete="off"
                maxLength={256}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="default"
              />
            </Field>
            {queueDiscoveryError && (
              <p role="status" className="-mt-2 text-xs text-warning">
                Existing queue suggestions unavailable — {queueDiscoveryError.message}. You can
                still enter a queue name manually.{' '}
                <button
                  type="button"
                  onClick={() => void refetchQueues()}
                  className="font-medium underline underline-offset-2 hover:text-fg"
                >
                  Retry
                </button>
              </p>
            )}
            <div>
              <Field label="Data (JSON)">
                <textarea
                  name="job-data"
                  value={dataText}
                  onChange={(e) => setDataText(e.target.value)}
                  onBlur={() => {
                    // Validate on blur so a typo surfaces while the field is
                    // still in view, not only after Submit.
                    const parsed = parseJobData(dataText);
                    setJsonErr(parsed.ok ? null : parsed.msg);
                  }}
                  maxLength={MAX_JOB_DATA_CHARS}
                  spellCheck={false}
                  rows={7}
                  className="w-full rounded-lg border border-line bg-surface-2 p-3 font-mono text-sm text-fg focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/30"
                />
              </Field>
              {jsonErr && (
                <p role="alert" className="mt-2 text-xs text-danger">
                  {jsonErr}
                </p>
              )}
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader title="Options" />
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
            <Field label="Priority">
              <Input
                type="number"
                min={-1_000_000}
                max={1_000_000}
                step={1}
                name="priority"
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                placeholder="0"
              />
            </Field>
            <Field label="Delay (ms)">
              <Input
                type="number"
                min={0}
                max={MAX_DELAY_MS}
                step={1}
                name="delay"
                value={delay}
                onChange={(e) => setDelay(e.target.value)}
                placeholder="0"
                disabled={runAt.trim() !== ''}
              />
            </Field>
            <Field
              label="Run at"
              hint={
                runAt.trim()
                  ? 'Overrides Delay — derived from this time (local time).'
                  : '(local time)'
              }
            >
              <Input
                type="datetime-local"
                name="run-at"
                value={runAt}
                onChange={(e) => setRunAt(e.target.value)}
              />
            </Field>
            <Field label="Max attempts" hint="blank = server default">
              <Input
                type="number"
                min={1}
                max={1000}
                step={1}
                name="max-attempts"
                value={maxAttempts}
                onChange={(e) => setMaxAttempts(e.target.value)}
                placeholder="3"
              />
            </Field>
            <Field label="Backoff (ms)" hint="blank = server default">
              <Input
                type="number"
                min={0}
                max={MAX_DURATION_MS}
                step={1}
                name="backoff"
                value={backoff}
                onChange={(e) => setBackoff(e.target.value)}
                placeholder="1000"
              />
            </Field>
            <Field label="Backoff strategy" hint="flat delay unless set">
              <Select
                name="backoff-strategy"
                value={backoffType}
                onChange={(e) => setBackoffType(e.target.value as '' | 'fixed' | 'exponential')}
              >
                <option value="">flat</option>
                <option value="fixed">fixed</option>
                <option value="exponential">exponential</option>
              </Select>
            </Field>
            <Field label="Timeout (ms)">
              <Input
                type="number"
                min={0}
                max={MAX_DURATION_MS}
                step={1}
                name="timeout"
                value={timeout}
                onChange={(e) => setTimeout(e.target.value)}
                placeholder="—"
              />
            </Field>
            <Field label="TTL (ms)" hint="blank = no expiry">
              <Input
                type="number"
                min={0}
                max={MAX_DELAY_MS}
                step={1}
                name="ttl"
                value={ttl}
                onChange={(e) => setTtl(e.target.value)}
                placeholder="—"
              />
            </Field>
            <Field label="Custom job ID">
              <Input
                name="custom-job-id"
                value={jobId}
                onChange={(e) => setJobId(e.target.value)}
                placeholder="idempotency key"
              />
            </Field>
          </div>
          <div className="mt-4 flex flex-wrap gap-6">
            <ToggleRow
              label="removeOnComplete"
              checked={removeOnComplete}
              onChange={setRemoveOnComplete}
            />
            <ToggleRow label="removeOnFail" checked={removeOnFail} onChange={setRemoveOnFail} />
            <ToggleRow label="durable" checked={durable} onChange={setDurable} />
            <ToggleRow label="lifo" checked={lifo} onChange={setLifo} />
          </div>

          <div className="mt-4 border-t border-line pt-4">
            <div className="mb-3 text-[11px] uppercase tracking-wider text-faint">Advanced</div>
            <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
              <Field label="Tags" hint="comma-separated">
                <Input
                  name="tags"
                  value={tags}
                  onChange={(e) => setTags(e.target.value)}
                  placeholder="email, urgent"
                />
              </Field>
              <Field label="Group ID">
                <Input
                  name="group-id"
                  value={groupId}
                  onChange={(e) => setGroupId(e.target.value)}
                  placeholder="—"
                />
              </Field>
              <Field label="Unique key" hint="dedup key">
                <Input
                  name="unique-key"
                  value={uniqueKey}
                  onChange={(e) => setUniqueKey(e.target.value)}
                  placeholder="—"
                />
              </Field>
              <Field label="Depends on" hint="parent job ids, comma-separated">
                <Input
                  name="depends-on"
                  value={dependsOn}
                  onChange={(e) => setDependsOn(e.target.value)}
                  placeholder="job-id-1, job-id-2"
                />
              </Field>
              <div className="col-span-2 md:col-span-3">
                <Field
                  label="Repeat policy (JSON)"
                  hint='v2.8.57-safe form: e.g. {"every":60000,"limit":10}. Use Cron Manager for cron patterns.'
                >
                  <textarea
                    name="repeat-policy"
                    value={repeatText}
                    onChange={(e) => setRepeatText(e.target.value)}
                    rows={2}
                    spellCheck={false}
                    placeholder='{"every": 60000}'
                    className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-xs text-fg placeholder:text-faint focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/30"
                  />
                </Field>
              </div>
            </div>
          </div>
        </Card>

        <div className="flex flex-wrap items-end gap-3 lg:col-span-2">
          <div className="w-28">
            <Field label="Count" hint="1–10000">
              <Input
                type="number"
                min={1}
                max={10000}
                step={1}
                name="count"
                value={count}
                onChange={(e) => setCount(e.target.value)}
              />
            </Field>
          </div>
          <Button type="submit" variant="accent" disabled={busy}>
            {busy ? 'Adding…' : 'Add job'}
          </Button>
          {result && (
            <span
              role={result.ok ? 'status' : 'alert'}
              className={result.ok ? 'text-sm text-success' : 'text-sm text-danger'}
            >
              {result.msg}
            </span>
          )}
        </div>
      </form>
    </div>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Toggle checked={checked} onChange={onChange} label={label} />
      <span className="font-mono text-xs text-muted">{label}</span>
    </div>
  );
}
