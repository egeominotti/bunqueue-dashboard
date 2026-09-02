import type { Backoff, RepeatOptions } from '@/lib/bq';
import type { CloneJobState } from '@/lib/cloneJob';
import { queueHttpPathError } from '@/lib/upstreamPaths';

export const MAX_DELAY_MS = 365 * 24 * 60 * 60 * 1000;
export const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
export const MAX_GROUP_PRIORITY = 2_097_151;

interface AddJobNumericInput {
  priority: string;
  delay: string;
  maxAttempts: string;
  backoff: string;
  timeout: string;
  ttl?: string;
  groupMaxSize?: string;
}

interface AddJobNumericOptions {
  priority?: number;
  delay?: number;
  maxAttempts?: number;
  backoff?: number;
  timeout?: number;
  ttl?: number;
  groupMaxSize?: number;
}

export function parseAddJobNumbers(
  raw: AddJobNumericInput,
  grouped = false
): { ok: true; options: AddJobNumericOptions } | { ok: false; msg: string } {
  const rules: Array<{
    key: keyof AddJobNumericInput;
    label: string;
    min: number;
    max: number;
  }> = [
    {
      key: 'priority',
      label: grouped ? 'Group priority' : 'Priority',
      min: grouped ? 0 : -1_000_000,
      max: grouped ? MAX_GROUP_PRIORITY : 1_000_000,
    },
    { key: 'delay', label: 'Delay', min: 0, max: MAX_DELAY_MS },
    { key: 'maxAttempts', label: 'Max attempts', min: 1, max: 1000 },
    { key: 'backoff', label: 'Backoff', min: 0, max: MAX_DURATION_MS },
    { key: 'timeout', label: 'Timeout', min: 0, max: MAX_DURATION_MS },
    { key: 'ttl', label: 'TTL', min: 0, max: MAX_DELAY_MS },
    {
      key: 'groupMaxSize',
      label: 'Group max size',
      min: 1,
      max: Number.MAX_SAFE_INTEGER,
    },
  ];
  const options: AddJobNumericOptions = {};
  for (const rule of rules) {
    const text = (raw[rule.key] ?? '').trim();
    if (!text) continue;
    const value = Number(text);
    if (!Number.isFinite(value)) return { ok: false, msg: `${rule.label} must be a number` };
    if (!Number.isSafeInteger(value)) {
      return { ok: false, msg: `${rule.label} must be a whole, safe integer` };
    }
    if (value < rule.min || value > rule.max) {
      return { ok: false, msg: `${rule.label} must be between ${rule.min} and ${rule.max}` };
    }
    options[rule.key] = value;
  }
  return { ok: true, options };
}

export function queueNameError(queue: string): string | null {
  const error = queueHttpPathError(queue);
  return !queue && error ? 'Choose a queue' : error;
}

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
        msg: 'repeat.pattern is unsafe in bunqueue v2.9.3; use repeat.every or a Cron schedule',
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
    return {
      ok: true,
      repeat: {
        every: every as number,
        ...(typeof raw.limit === 'number' ? { limit: raw.limit } : {}),
      },
    };
  } catch (error) {
    return { ok: false, msg: `Repeat is not valid JSON: ${(error as Error).message}` };
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

export function addJobCloneDefaults(options: CloneOptions): AddJobCloneDefaults {
  const embeddedConfig = typeof options.backoff === 'object' ? options.backoff : undefined;
  const config = options.backoffConfig ?? embeddedConfig;
  return {
    backoff: numberString(
      config?.delay ?? (typeof options.backoff === 'number' ? options.backoff : undefined)
    ),
    backoffType: config?.type ?? '',
    tags: options.tags?.join(', ') ?? '',
    groupId: options.groupId ?? '',
    ttl: numberString(options.ttl),
  };
}

export const numberString = (value: number | undefined): string =>
  value == null ? '' : String(value);
