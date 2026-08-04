import type { CreateCronBody, CronJobOptions } from '@/lib/bq';
import { decodedHttpPathError } from '@/lib/upstreamPaths';
import { parseJobData } from '../addJob/data';
import { queueNameError } from '../addJob/options';

export const MAX_DELAY_MS = 365 * 24 * 60 * 60 * 1000;
export const MAX_DURATION_MS = 24 * 60 * 60 * 1000;

export interface CronFormValues {
  name: string;
  jobName?: string;
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

export type SetCronFormValue = <K extends keyof CronFormValues>(
  key: K,
  value: CronFormValues[K]
) => void;

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
  `Cron "${name}" already exists. Bunqueue v2.8.57 does not return complete cron definitions, so editing could reset hidden options. Delete it explicitly, wait for the list to refresh, then create the replacement as a separate action.`;

export function existingCronNameError(
  name: string,
  existingNames: ReadonlySet<string>
): string | null {
  const normalized = name.trim();
  return normalized && existingNames.has(normalized) ? cronAlreadyExistsMessage(normalized) : null;
}

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

export function everyPreview(raw: string): string | null {
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
      const value = ms / size;
      return `${Number.isInteger(value) ? '' : '≈ '}every ${Math.round(value * 10) / 10}${suffix}`;
    }
  }
  return null;
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
  const jobName = values.jobName?.trim() || 'default';
  if (jobName.length > 256) {
    return { ok: false, msg: 'Spawned job name must be 256 characters or fewer' };
  }

  let data: unknown = {};
  if (values.dataText.trim()) {
    const parsed = parseJobData(values.dataText);
    if (!parsed.ok) {
      return { ok: false, msg: parsed.kind === 'json' ? 'Data is not valid JSON' : parsed.msg };
    }
    data = parsed.data;
  }

  const body: CreateCronBody = {
    name,
    jobName,
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
    body.schedule = schedule;
  } else {
    const interval = parseOptionalWhole(values.every, 'Interval', 1, MAX_DELAY_MS);
    if (!interval.ok || interval.value === undefined) {
      return { ok: false, msg: interval.ok ? 'Interval is required' : interval.msg };
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

  const checks: Array<{
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
  for (const check of checks) {
    const parsed = parseOptionalWhole(check.raw, check.label, check.min, check.max);
    if (!parsed.ok) return parsed;
    if (parsed.value !== undefined) jobOptions[check.key] = parsed.value;
  }
  if (values.jobRemoveOnComplete) jobOptions.removeOnComplete = true;
  if (values.jobRemoveOnFail) jobOptions.removeOnFail = true;
  if (Object.keys(jobOptions).length) body.jobOptions = jobOptions;
  return { ok: true, body };
}
