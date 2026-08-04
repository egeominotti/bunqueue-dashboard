import type { BulkJobBody } from '@/lib/bq';
import { opaqueHttpIdError } from '@/lib/upstreamPaths';
import { MAX_JOB_DATA_BYTES, MAX_JOB_DATA_CHARS, utf8ByteLength } from '../addJob/data';
import { parseRepeat } from '../addJob/options';
import {
  asBackoff,
  asNum,
  asPlainObject,
  asStr,
  asStringList,
  type BulkDefaults,
  coerceBody,
  numericError,
  type ParseMode,
  parseDedup,
  SPEC_KEYS,
} from './coercion';
import { MAX_BULK_PAYLOAD_BYTES, MAX_DELAY_MS, MAX_DURATION_MS, MAX_JOBS } from './constants';

export function parseBulkDefaults(raw: {
  priority: string;
  maxAttempts: string;
  backoff: string;
  timeout: string;
}): { ok: true; defaults: BulkDefaults } | { ok: false; msg: string } {
  const values: Record<keyof BulkDefaults, unknown> = {
    priority: raw.priority.trim() || undefined,
    maxAttempts: raw.maxAttempts.trim() || undefined,
    backoff: raw.backoff.trim() || undefined,
    timeout: raw.timeout.trim() || undefined,
  };
  const checks: Array<[keyof BulkDefaults, string, number, number]> = [
    ['priority', 'Default priority', -1_000_000, 1_000_000],
    ['maxAttempts', 'Default max attempts', 1, 1000],
    ['backoff', 'Default backoff', 0, MAX_DURATION_MS],
    ['timeout', 'Default timeout', 0, MAX_DURATION_MS],
  ];
  const defaults: BulkDefaults = {};
  for (const [key, label, min, max] of checks) {
    const error = numericError(values[key], label, min, max);
    if (error) return { ok: false, msg: error };
    const value = asNum(values[key]);
    if (value !== undefined) defaults[key] = value;
  }
  return { ok: true, defaults };
}

function specOptionError(raw: Record<string, unknown>): string | null {
  const unknown = Object.keys(raw).filter((key) => !SPEC_KEYS.has(key));
  if (unknown.length) return `unknown job option(s): ${unknown.join(', ')}`;

  const numericChecks: Array<[string, string, number, number]> = [
    ['priority', 'priority', -1_000_000, 1_000_000],
    ['delay', 'delay', 0, MAX_DELAY_MS],
    ['maxAttempts', 'maxAttempts', 1, 1000],
    ['timeout', 'timeout', 0, MAX_DURATION_MS],
    ['ttl', 'ttl', 0, MAX_DELAY_MS],
    ['stallTimeout', 'stallTimeout', 0, MAX_DURATION_MS],
    ['stackTraceLimit', 'stackTraceLimit', 0, 10_000],
    ['timestamp', 'timestamp', 0, Number.MAX_SAFE_INTEGER],
  ];
  for (const [key, label, min, max] of numericChecks) {
    const error = numericError(raw[key], label, min, max);
    if (error) return error;
  }

  if (raw.backoff !== undefined) {
    const backoff = asBackoff(raw.backoff);
    if (backoff === undefined) {
      return 'backoff must be a number or {"type":"fixed|exponential","delay":number} with no extra keys';
    }
    const error = numericError(
      typeof backoff === 'number' ? backoff : backoff.delay,
      'backoff delay',
      0,
      MAX_DURATION_MS
    );
    if (error) return error;
  }

  if (raw.repeat !== undefined) {
    const repeatObject = asPlainObject<Record<string, unknown>>(raw.repeat);
    if (!repeatObject) return 'repeat must be an object';
    const repeat = parseRepeat(JSON.stringify(repeatObject));
    if (!repeat.ok) return repeat.msg;
  }
  if (raw.dedup !== undefined) {
    const dedup = parseDedup(raw.dedup);
    if (!dedup.ok) return `dedup ${dedup.msg}`;
    if (asStr(raw.uniqueKey) === undefined) return 'dedup requires a non-empty uniqueKey';
  }

  for (const key of ['removeOnComplete', 'removeOnFail', 'durable', 'lifo']) {
    if (raw[key] !== undefined && typeof raw[key] !== 'boolean') return `${key} must be a boolean`;
  }
  for (const key of ['jobId', 'customId', 'uniqueKey']) {
    const value = raw[key];
    if (value === undefined) continue;
    const string = asStr(value);
    if (string === undefined || string.length > 1024) {
      return `${key} must be a non-empty string (or finite numeric id) of at most 1024 characters`;
    }
    if ((key === 'jobId' || key === 'customId') && opaqueHttpIdError(string)) {
      return `${key}: ${opaqueHttpIdError(string)}`;
    }
  }
  const jobId = asStr(raw.jobId);
  const customId = asStr(raw.customId);
  if (jobId !== undefined && customId !== undefined && jobId !== customId) {
    return 'jobId and customId disagree; provide only one spelling';
  }

  if (raw.groupId !== undefined) {
    const groupId = asStr(raw.groupId);
    if (groupId === undefined || groupId.length > 256) {
      return 'groupId must be a non-empty string of at most 256 characters';
    }
  }
  for (const key of ['tags', 'dependsOn'] as const) {
    if (raw[key] === undefined) continue;
    const list = asStringList(raw[key]);
    const maxLength = key === 'tags' ? 256 : 1024;
    if (!list || list.some((item) => item.length > maxLength)) {
      return `${key} must be an array of non-empty strings of at most ${maxLength} characters`;
    }
    if (key === 'dependsOn') {
      const unsupported = list.find((item) => opaqueHttpIdError(item));
      if (unsupported) return `dependsOn ID "${unsupported}": ${opaqueHttpIdError(unsupported)}`;
    }
  }
  return null;
}

export function bulkDependencyError(bodies: BulkJobBody[]): string | null {
  const byId = new Map<string, BulkJobBody>();
  for (const body of bodies) {
    if (!body.jobId) continue;
    if (byId.has(body.jobId)) {
      return `duplicate jobId/customId "${body.jobId}" makes dependency resolution ambiguous`;
    }
    byId.set(body.jobId, body);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      if (byId.has(dependency) && visit(dependency)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  for (const id of byId.keys()) {
    if (visit(id)) return `dependency cycle detected in this batch (involving "${id}")`;
  }
  return null;
}

export function validateBulkItems(
  items: unknown[],
  defaults: BulkDefaults,
  mode: ParseMode
): { ok: true; bodies: BulkJobBody[] } | { ok: false; msg: string } {
  if (items.length > MAX_JOBS) {
    return { ok: false, msg: `Too many jobs (${items.length}). Limit is ${MAX_JOBS}.` };
  }
  const bodies: BulkJobBody[] = [];
  let totalDataBytes = 0;
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (mode === 'spec' && isJobSpec(item)) {
      const error = specOptionError(item);
      if (error) return { ok: false, msg: `Job ${index + 1}: ${error}` };
    }
    const body = coerceBody(item, defaults, mode);
    let encoded: string | undefined;
    try {
      encoded = JSON.stringify(body.data);
    } catch {
      return { ok: false, msg: `Job ${index + 1}: data must be JSON serializable` };
    }
    if (encoded === undefined) {
      return { ok: false, msg: `Job ${index + 1}: data must be JSON serializable` };
    }
    if (encoded.length > MAX_JOB_DATA_CHARS) {
      return { ok: false, msg: `Job ${index + 1}: data exceeds the 10 MiB UTF-8 limit` };
    }
    const encodedBytes = utf8ByteLength(encoded, MAX_JOB_DATA_BYTES);
    if (encodedBytes > MAX_JOB_DATA_BYTES) {
      return { ok: false, msg: `Job ${index + 1}: data exceeds the 10 MiB UTF-8 limit` };
    }
    totalDataBytes += encodedBytes;
    if (totalDataBytes > MAX_BULK_PAYLOAD_BYTES) {
      return { ok: false, msg: 'Combined job data exceeds the 64 MiB import safety limit' };
    }
    bodies.push(body);
  }
  const dependencyError = bulkDependencyError(bodies);
  return dependencyError ? { ok: false, msg: dependencyError } : { ok: true, bodies };
}

const isJobSpec = (item: unknown): item is Record<string, unknown> =>
  item != null && typeof item === 'object' && !Array.isArray(item) && 'data' in item;
