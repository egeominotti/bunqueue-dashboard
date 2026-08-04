import type { Backoff, BulkJobBody, DedupOptions, RepeatOptions } from '@/lib/bq';
import { parseRepeat } from '../addJob/options';
import { MAX_DELAY_MS } from './constants';

export type ParseMode = 'spec' | 'raw';

export interface BulkDefaults {
  priority?: number;
  maxAttempts?: number;
  backoff?: number;
  timeout?: number;
}

export const asNum = (value: unknown): number | undefined => {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value.trim()) : value;
  return typeof number === 'number' && Number.isFinite(number) ? number : undefined;
};

const asBool = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

export const asStr = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value.trim() !== '' ? value.trim() : undefined;
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined;
};

export const asStringList = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const values = value.map(asStr);
  return values.every((item): item is string => item !== undefined) ? values : undefined;
};

export const asPlainObject = <T>(value: unknown): T | undefined =>
  value != null && typeof value === 'object' && !Array.isArray(value) ? (value as T) : undefined;

export const asBackoff = (value: unknown): Backoff | undefined => {
  const numeric = asNum(value);
  if (numeric !== undefined) return numeric;
  const raw = asPlainObject<Record<string, unknown>>(value);
  if (!raw || (raw.type !== 'fixed' && raw.type !== 'exponential')) return undefined;
  if (Object.keys(raw).some((key) => key !== 'type' && key !== 'delay')) return undefined;
  const delay = asNum(raw.delay);
  return delay === undefined ? undefined : { type: raw.type, delay };
};

const asRepeat = (value: unknown): RepeatOptions | undefined => {
  const raw = asPlainObject<Record<string, unknown>>(value);
  if (!raw) return undefined;
  const parsed = parseRepeat(JSON.stringify(raw));
  return parsed.ok ? parsed.repeat : undefined;
};

export function parseDedup(
  value: unknown
): { ok: true; dedup: DedupOptions } | { ok: false; msg: string } {
  const raw = asPlainObject<Record<string, unknown>>(value);
  if (!raw) return { ok: false, msg: 'must be an object' };
  const allowed = new Set(['ttl', 'extend', 'replace']);
  const unknown = Object.keys(raw).filter((key) => !allowed.has(key));
  if (unknown.length) return { ok: false, msg: `has unknown option(s): ${unknown.join(', ')}` };
  if (
    raw.ttl !== undefined &&
    (!Number.isSafeInteger(raw.ttl) ||
      (raw.ttl as number) <= 0 ||
      (raw.ttl as number) > MAX_DELAY_MS)
  ) {
    return { ok: false, msg: `ttl must be a whole number from 1 to ${MAX_DELAY_MS} ms` };
  }
  for (const key of ['extend', 'replace'] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== 'boolean') {
      return { ok: false, msg: `${key} must be a boolean` };
    }
  }
  if (raw.extend === true && raw.replace === true) {
    return { ok: false, msg: 'extend and replace are mutually exclusive' };
  }
  if (raw.extend === true && raw.ttl === undefined) {
    return { ok: false, msg: 'extend requires ttl' };
  }
  return {
    ok: true,
    dedup: {
      ...(typeof raw.ttl === 'number' ? { ttl: raw.ttl } : {}),
      ...(typeof raw.extend === 'boolean' ? { extend: raw.extend } : {}),
      ...(typeof raw.replace === 'boolean' ? { replace: raw.replace } : {}),
    },
  };
}

const asDedup = (value: unknown): DedupOptions | undefined => {
  const parsed = parseDedup(value);
  return parsed.ok ? parsed.dedup : undefined;
};

export function coerceBody(element: unknown, defaults: BulkDefaults, mode: ParseMode): BulkJobBody {
  if (
    mode === 'spec' &&
    element &&
    typeof element === 'object' &&
    !Array.isArray(element) &&
    'data' in element
  ) {
    const raw = element as Record<string, unknown>;
    return {
      name: asStr(raw.name),
      data: raw.data,
      priority: asNum(raw.priority) ?? defaults.priority,
      delay: asNum(raw.delay),
      maxAttempts: asNum(raw.maxAttempts) ?? defaults.maxAttempts,
      backoff: asBackoff(raw.backoff) ?? defaults.backoff,
      timeout: asNum(raw.timeout) ?? defaults.timeout,
      jobId: asStr(raw.jobId) ?? asStr(raw.customId),
      removeOnComplete: asBool(raw.removeOnComplete),
      removeOnFail: asBool(raw.removeOnFail),
      durable: asBool(raw.durable),
      lifo: asBool(raw.lifo),
      ttl: asNum(raw.ttl),
      uniqueKey: asStr(raw.uniqueKey),
      tags: asStringList(raw.tags),
      groupId: asStr(raw.groupId),
      dependsOn: asStringList(raw.dependsOn),
      stallTimeout: asNum(raw.stallTimeout),
      repeat: asRepeat(raw.repeat),
      dedup: asDedup(raw.dedup),
      stackTraceLimit: asNum(raw.stackTraceLimit),
      timestamp: asNum(raw.timestamp),
    };
  }
  return { data: element, ...defaults };
}

export const SPEC_KEYS = new Set([
  'name',
  'data',
  'priority',
  'delay',
  'maxAttempts',
  'backoff',
  'timeout',
  'jobId',
  'customId',
  'removeOnComplete',
  'removeOnFail',
  'durable',
  'lifo',
  'ttl',
  'uniqueKey',
  'tags',
  'groupId',
  'dependsOn',
  'stallTimeout',
  'repeat',
  'dedup',
  'stackTraceLimit',
  'timestamp',
]);

const SPEC_COERCERS: Record<string, (value: unknown) => unknown> = {
  name: asStr,
  priority: asNum,
  delay: asNum,
  maxAttempts: asNum,
  backoff: asBackoff,
  timeout: asNum,
  ttl: asNum,
  jobId: asStr,
  customId: asStr,
  uniqueKey: asStr,
  removeOnComplete: asBool,
  removeOnFail: asBool,
  durable: asBool,
  lifo: asBool,
  tags: asStringList,
  groupId: asStr,
  dependsOn: asStringList,
  stallTimeout: asNum,
  repeat: asRepeat,
  dedup: asDedup,
  stackTraceLimit: asNum,
  timestamp: asNum,
};

export function specWouldDropValues(items: unknown[]): boolean {
  return items.some((element) => {
    if (
      element == null ||
      typeof element !== 'object' ||
      Array.isArray(element) ||
      !('data' in element)
    ) {
      return false;
    }
    const raw = element as Record<string, unknown>;
    return Object.keys(raw).some((key) => {
      const coerce = SPEC_COERCERS[key];
      return coerce != null && raw[key] !== undefined && coerce(raw[key]) === undefined;
    });
  });
}

export function numericError(
  value: unknown,
  label: string,
  min: number,
  max: number
): string | null {
  if (value === undefined) return null;
  const number = asNum(value);
  if (number === undefined) return `${label} must be a number`;
  if (!Number.isSafeInteger(number)) return `${label} must be a whole, safe integer`;
  if (number < min || number > max) return `${label} must be between ${min} and ${max}`;
  return null;
}
