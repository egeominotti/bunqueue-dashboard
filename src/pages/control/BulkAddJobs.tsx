import { type ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from '@/components/dashboard/stores/toastStore';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Field, Input, SegmentedControl } from '@/components/ui/form';
import { PageHeader } from '@/components/ui/PageHeader';
import {
  type Backoff,
  type BulkJobBody,
  bq,
  bulkJobPayloadBudgetError,
  type DedupOptions,
  type RepeatOptions,
} from '@/lib/bq';
import { opaqueHttpIdError } from '@/lib/upstreamPaths';
import { usePolledData } from '@/lib/usePolledData';
import { useServerActionGuard } from '@/lib/useServerActionGuard';
import {
  acceptedBulkIds,
  MAX_JOB_DATA_BYTES,
  MAX_JOB_DATA_CHARS,
  parseRepeat,
  queueNameError,
  utf8ByteLength,
} from './AddJob';

const MAX_JOBS = 10000;
const MAX_DELAY_MS = 365 * 24 * 60 * 60 * 1000;
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
export const MAX_BULK_INPUT_BYTES = 64 * 1024 * 1024;
export const MAX_BULK_INPUT_CHARS = 64 * 1024 * 1024;
export const MAX_BULK_PAYLOAD_BYTES = 64 * 1024 * 1024;
/** How each parsed item is interpreted (see coerceBody). */
type ParseMode = 'spec' | 'raw';

const SAMPLE = `[
  { "data": { "to": "a@example.com", "template": "welcome" }, "priority": 1 },
  { "data": { "to": "b@example.com", "template": "welcome" } }
]`;

// Records exported from a spreadsheet/CSV converter carry every scalar as a
// string, so coerce numeric strings (and stringify numeric ids) instead of
// dropping the option the operator wrote.
export const asNum = (v: unknown): number | undefined => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v.trim()) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};
const asBool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
export const asStr = (v: unknown): string | undefined => {
  if (typeof v === 'string') return v.trim() !== '' ? v.trim() : undefined;
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : undefined;
};

const asStringList = (v: unknown): string[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const values = v.map(asStr);
  return values.every((item): item is string => item !== undefined) ? values : undefined;
};

const asPlainObject = <T,>(v: unknown): T | undefined =>
  v != null && typeof v === 'object' && !Array.isArray(v) ? (v as T) : undefined;

const asBackoff = (v: unknown): Backoff | undefined => {
  const numeric = asNum(v);
  if (numeric !== undefined) return numeric;
  const raw = asPlainObject<Record<string, unknown>>(v);
  if (!raw || (raw.type !== 'fixed' && raw.type !== 'exponential')) return undefined;
  if (Object.keys(raw).some((key) => key !== 'type' && key !== 'delay')) return undefined;
  const delay = asNum(raw.delay);
  return delay === undefined ? undefined : { type: raw.type, delay };
};

const asRepeat = (v: unknown): RepeatOptions | undefined => {
  const raw = asPlainObject<Record<string, unknown>>(v);
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

const asDedup = (v: unknown): DedupOptions | undefined => {
  const parsed = parseDedup(v);
  return parsed.ok ? parsed.dedup : undefined;
};

export interface BulkDefaults {
  priority?: number;
  maxAttempts?: number;
  backoff?: number;
  timeout?: number;
}

/**
 * Turn one parsed element into an AddJobBody.
 * - `raw`  : the element IS the job's data, verbatim (never reinterpreted). Use
 *            this when your records happen to carry a `data`/`priority` column of
 *            their own that must be preserved.
 * - `spec` : an object with a `data` key is a full job spec ({ data, priority,
 *            delay, … }); anything else is treated as the job's data. Sibling keys
 *            outside the known option set are rejected before submission, so only
 *            use it for records you authored as job specs.
 * Shared defaults fill option fields a spec omits.
 */
export function coerceBody(el: unknown, def: BulkDefaults, mode: ParseMode): BulkJobBody {
  if (mode === 'spec' && el && typeof el === 'object' && !Array.isArray(el) && 'data' in el) {
    const o = el as Record<string, unknown>;
    return {
      data: o.data,
      priority: asNum(o.priority) ?? def.priority,
      delay: asNum(o.delay),
      maxAttempts: asNum(o.maxAttempts) ?? def.maxAttempts,
      backoff: asBackoff(o.backoff) ?? def.backoff,
      timeout: asNum(o.timeout) ?? def.timeout,
      // Accept both the dashboard/public spelling and bunqueue's domain spelling.
      jobId: asStr(o.jobId) ?? asStr(o.customId),
      removeOnComplete: asBool(o.removeOnComplete),
      removeOnFail: asBool(o.removeOnFail),
      durable: asBool(o.durable),
      lifo: asBool(o.lifo),
      ttl: asNum(o.ttl),
      uniqueKey: asStr(o.uniqueKey),
      tags: asStringList(o.tags),
      groupId: asStr(o.groupId),
      dependsOn: asStringList(o.dependsOn),
      stallTimeout: asNum(o.stallTimeout),
      repeat: asRepeat(o.repeat),
      dedup: asDedup(o.dedup),
      stackTraceLimit: asNum(o.stackTraceLimit),
      timestamp: asNum(o.timestamp),
    };
  }
  return { data: el, ...def };
}

const SPEC_KEYS = new Set([
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

/** The coercer each spec option goes through, so a value-typed drop is detectable. */
const SPEC_COERCERS: Record<string, (v: unknown) => unknown> = {
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
/** True when a `spec`-mode item carries a known option whose VALUE type can't be sent. */
export function specWouldDropValues(items: unknown[]): boolean {
  return items.some((el) => {
    if (el == null || typeof el !== 'object' || Array.isArray(el) || !('data' in el)) return false;
    const o = el as Record<string, unknown>;
    return Object.keys(o).some((k) => {
      const coerce = SPEC_COERCERS[k];
      return coerce != null && o[k] !== undefined && coerce(o[k]) === undefined;
    });
  });
}

const numericError = (
  value: unknown,
  label: string,
  min: number,
  max: number,
  integer: boolean
): string | null => {
  if (value === undefined) return null;
  const number = asNum(value);
  if (number === undefined) return `${label} must be a number`;
  if (integer && !Number.isSafeInteger(number)) return `${label} must be a whole, safe integer`;
  if (number < min || number > max) return `${label} must be between ${min} and ${max}`;
  return null;
};

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
  const checks: Array<[keyof BulkDefaults, string, number, number, boolean]> = [
    ['priority', 'Default priority', -1_000_000, 1_000_000, true],
    ['maxAttempts', 'Default max attempts', 1, 1000, true],
    ['backoff', 'Default backoff', 0, MAX_DURATION_MS, true],
    ['timeout', 'Default timeout', 0, MAX_DURATION_MS, true],
  ];
  const defaults: BulkDefaults = {};
  for (const [key, label, min, max, integer] of checks) {
    const error = numericError(values[key], label, min, max, integer);
    if (error) return { ok: false, msg: error };
    const value = asNum(values[key]);
    if (value !== undefined) defaults[key] = value;
  }
  return { ok: true, defaults };
}

function specOptionError(raw: Record<string, unknown>): string | null {
  const unknown = Object.keys(raw).filter((key) => !SPEC_KEYS.has(key));
  if (unknown.length) return `unknown job option(s): ${unknown.join(', ')}`;

  const numericChecks: Array<[string, string, number, number, boolean]> = [
    ['priority', 'priority', -1_000_000, 1_000_000, true],
    ['delay', 'delay', 0, MAX_DELAY_MS, true],
    ['maxAttempts', 'maxAttempts', 1, 1000, true],
    ['timeout', 'timeout', 0, MAX_DURATION_MS, true],
    ['ttl', 'ttl', 0, MAX_DELAY_MS, true],
    ['stallTimeout', 'stallTimeout', 0, MAX_DURATION_MS, true],
    ['stackTraceLimit', 'stackTraceLimit', 0, 10_000, true],
    ['timestamp', 'timestamp', 0, Number.MAX_SAFE_INTEGER, true],
  ];
  for (const [key, label, min, max, integer] of numericChecks) {
    const error = numericError(raw[key], label, min, max, integer);
    if (error) return error;
  }

  if (raw.backoff !== undefined) {
    const backoff = asBackoff(raw.backoff);
    if (backoff === undefined) {
      return 'backoff must be a number or {"type":"fixed|exponential","delay":number} with no extra keys';
    }
    const delay = typeof backoff === 'number' ? backoff : backoff.delay;
    const error = numericError(delay, 'backoff delay', 0, MAX_DURATION_MS, true);
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

  const booleanKeys = ['removeOnComplete', 'removeOnFail', 'durable', 'lifo'];
  for (const key of booleanKeys) {
    if (raw[key] !== undefined && typeof raw[key] !== 'boolean') return `${key} must be a boolean`;
  }

  const idKeys = ['jobId', 'customId', 'uniqueKey'];
  for (const key of idKeys) {
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
      const unsupported = list?.find((item) => opaqueHttpIdError(item));
      if (unsupported) return `dependsOn ID "${unsupported}": ${opaqueHttpIdError(unsupported)}`;
    }
  }

  return null;
}

/**
 * PUSHB is not an atomic flow constructor. Dependency-only jobs remain useful,
 * but a cycle made entirely from explicit ids in the same batch would leave the
 * jobs permanently blocked. Validate that locally while treating references to
 * existing jobs outside this import as opaque, server-authoritative edges.
 */
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
    if (
      mode === 'spec' &&
      item != null &&
      typeof item === 'object' &&
      !Array.isArray(item) &&
      'data' in item
    ) {
      const error = specOptionError(item as Record<string, unknown>);
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
  if (dependencyError) return { ok: false, msg: dependencyError };
  return { ok: true, bodies };
}

export function bulkInputBudgetError(text: string): string | null {
  if (
    text.length > MAX_BULK_INPUT_CHARS ||
    utf8ByteLength(text, MAX_BULK_INPUT_BYTES) > MAX_BULK_INPUT_BYTES
  ) {
    return 'Import text exceeds the 64 MiB UTF-8 safety limit';
  }
  return null;
}

/** Validate the exact JSON envelope size before bq creates its transport copy. */
export function bulkPayloadBudgetError(
  bodies: BulkJobBody[],
  maxBytes = MAX_BULK_PAYLOAD_BYTES
): string | null {
  return bulkJobPayloadBudgetError(bodies, maxBytes);
}

export function bulkSummary(
  distinctIds: number,
  submitted: number,
  queue: string
): { ok: boolean; msg: string } {
  return {
    ok: true,
    msg: `Accepted ${submitted} job submission${submitted === 1 ? '' : 's'} in ${queue}; server returned ${distinctIds} distinct job ID${distinctIds === 1 ? '' : 's'} (deduplication may reuse existing jobs)`,
  };
}

/** Parse the textarea as a JSON array, a single JSON object, or NDJSON (one per line). */
export function parseInput(text: string): { items: unknown[]; error: string | null } {
  const budgetError = bulkInputBudgetError(text);
  if (budgetError) return { items: [], error: budgetError };
  const trimmed = text.trim();
  if (!trimmed) return { items: [], error: null };
  // Try whole-document JSON first (array or single object).
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return { items: parsed, error: null };
    return { items: [parsed], error: null };
  } catch {
    /* fall through to NDJSON */
  }
  // NDJSON: one JSON value per non-empty line.
  const items: unknown[] = [];
  // Split the UNTRIMMED text so a reported line number matches the textarea:
  // leading blank lines would otherwise shift every index.
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      items.push(JSON.parse(line));
    } catch (e) {
      return { items: [], error: `Line ${i + 1}: ${(e as Error).message}` };
    }
  }
  return { items, error: null };
}

/**
 * Bulk-import distinct jobs from a pasted JSON array / NDJSON / uploaded file, in a
 * single `POST /queues/:q/jobs/bulk` call. Complements Add Job, whose Count field
 * only replicates one identical payload; this is for seeding or replaying a batch
 * of *different* payloads (e.g. re-importing many order records).
 */
export function BulkAddJobs() {
  const {
    data: qs,
    error: queueDiscoveryError,
    refetch: refetchQueues,
  } = usePolledData(() => bq.queues(), [], { intervalMs: 30000 });
  const [queue, setQueue] = useState('');
  const [text, setText] = useState('');
  const [mode, setMode] = useState<ParseMode>('spec');
  const [priority, setPriority] = useState('');
  const [maxAttempts, setMaxAttempts] = useState('');
  const [backoff, setBackoff] = useState('');
  const [timeout, setTimeout] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const fileReaderRef = useRef<FileReader | null>(null);
  const fileReadGenerationRef = useRef(0);
  const actionGuard = useServerActionGuard('bulk-add-jobs');
  // biome-ignore lint/correctness/useExhaustiveDependencies: scopeKey is the connection lifecycle boundary
  useEffect(() => {
    setBusy(false);
    setResult(null);
  }, [actionGuard.scopeKey]);
  useEffect(
    () => () => {
      fileReadGenerationRef.current += 1;
      const reader = fileReaderRef.current;
      fileReaderRef.current = null;
      try {
        reader?.abort();
      } catch {
        // A browser may throw if its reader has already transitioned to DONE.
      }
    },
    []
  );

  const { items, error } = useMemo(() => parseInput(text), [text]);
  const importValidation = useMemo(() => {
    if (error) return { ok: false as const, msg: error };
    if (items.length > MAX_JOBS) {
      return { ok: false as const, msg: `Too many jobs (${items.length}). Limit is ${MAX_JOBS}.` };
    }
    const parsedDefaults = parseBulkDefaults({ priority, maxAttempts, backoff, timeout });
    if (!parsedDefaults.ok) return parsedDefaults;
    return validateBulkItems(items, parsedDefaults.defaults, mode);
  }, [backoff, error, items, maxAttempts, mode, priority, timeout]);

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    const generation = fileReadGenerationRef.current + 1;
    fileReadGenerationRef.current = generation;
    const previous = fileReaderRef.current;
    fileReaderRef.current = null;
    try {
      previous?.abort();
    } catch {
      // Generation ownership below still suppresses a reader that cannot abort.
    }
    // Reset immediately so every exit path still allows selecting this file again.
    input.value = '';

    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_BULK_INPUT_BYTES) {
      setResult({ ok: false, msg: `File is too large; maximum is 64 MiB (${file.name})` });
      return;
    }
    // Loading a file replaces the textarea wholesale — don't silently blow away
    // something the operator already pasted or edited.
    if (text.trim() !== '' && !window.confirm(`Replace the current input with "${file.name}"?`)) {
      return;
    }
    const reader = new FileReader();
    const isCurrent = () =>
      fileReadGenerationRef.current === generation && fileReaderRef.current === reader;
    const finish = () => {
      if (isCurrent()) fileReaderRef.current = null;
    };
    reader.onload = () => {
      if (!isCurrent()) return;
      if (typeof reader.result !== 'string') {
        setResult({ ok: false, msg: `Could not decode file as text (${file.name})` });
        finish();
        return;
      }
      const loaded = reader.result;
      const budgetError = bulkInputBudgetError(loaded);
      if (budgetError) setResult({ ok: false, msg: `${budgetError} (${file.name})` });
      else {
        setText(loaded);
        setResult(null);
      }
      finish();
    };
    reader.onerror = () => {
      if (!isCurrent()) return;
      setResult({ ok: false, msg: `Could not read file (${file.name})` });
      finish();
    };
    reader.onabort = finish;
    fileReaderRef.current = reader;
    setResult(null);
    try {
      reader.readAsText(file);
    } catch {
      if (!isCurrent()) return;
      setResult({ ok: false, msg: `Could not read file (${file.name})` });
      finish();
    }
  };

  const submit = async () => {
    setResult(null);
    // Submit the string that passed validation — a trailing space would create a
    // phantom look-alike queue and misroute the whole batch.
    const target = queue.trim();
    const invalidQueue = queueNameError(target);
    if (invalidQueue) {
      setResult({ ok: false, msg: invalidQueue });
      return;
    }
    const inputBudgetError = bulkInputBudgetError(text);
    if (inputBudgetError) {
      setResult({ ok: false, msg: inputBudgetError });
      return;
    }
    if (error) {
      setResult({ ok: false, msg: error });
      return;
    }
    if (items.length === 0) {
      setResult({ ok: false, msg: 'Nothing to enqueue — paste a JSON array or NDJSON.' });
      return;
    }
    if (items.length > MAX_JOBS) {
      setResult({ ok: false, msg: `Too many jobs (${items.length}). Limit is ${MAX_JOBS}.` });
      return;
    }
    if (!importValidation.ok) {
      setResult({ ok: false, msg: importValidation.msg });
      return;
    }
    const bodies = importValidation.bodies;
    const payloadBudgetError = bulkPayloadBudgetError(bodies);
    if (payloadBudgetError) {
      setResult({ ok: false, msg: payloadBudgetError });
      return;
    }
    const lease = actionGuard.begin();
    if (!lease) return;
    setBusy(true);
    try {
      const r = await bq.addJobsBulk(target, bodies);
      const ids = acceptedBulkIds(r, bodies.length);
      if (!lease.isCurrent()) return;
      const summary = bulkSummary(new Set(ids).size, bodies.length, target);
      setResult(summary);
      toast.success(summary.msg);
    } catch (e) {
      if (!lease.isCurrent()) return;
      const m = (e as Error).message;
      setResult({ ok: false, msg: m });
      toast.error('Bulk import failed', m);
    } finally {
      if (lease.finish()) setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Bulk Add Jobs"
        description="Import many distinct jobs at once from a JSON array, NDJSON, or a file."
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title="Jobs"
            action={
              <label className="cursor-pointer rounded-lg border border-line px-3 py-1.5 text-xs text-muted hover:bg-surface-2 hover:text-fg">
                Upload file
                <input
                  type="file"
                  name="jobs-file"
                  accept=".json,.ndjson,.txt,application/json"
                  onChange={onFile}
                  className="hidden"
                />
              </label>
            }
          />
          <textarea
            name="jobs-json"
            value={text}
            onChange={(e) => {
              fileReadGenerationRef.current += 1;
              const reader = fileReaderRef.current;
              fileReaderRef.current = null;
              try {
                reader?.abort();
              } catch {
                // The generation still prevents a late load from replacing edits.
              }
              setText(e.target.value);
            }}
            maxLength={MAX_BULK_INPUT_CHARS}
            spellCheck={false}
            rows={16}
            placeholder={SAMPLE}
            aria-label="Jobs JSON"
            className="w-full rounded-lg border border-line bg-surface-2 p-3 font-mono text-xs text-fg placeholder:text-faint focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
          <fieldset className="mt-3 flex flex-wrap items-center gap-3">
            <legend className="sr-only">Import interpretation</legend>
            <span aria-hidden="true" className="text-xs font-medium text-faint">
              Interpret each item as
            </span>
            <SegmentedControl options={['spec', 'raw'] as const} value={mode} onChange={setMode} />
            <span className="text-xs text-faint">
              {mode === 'spec'
                ? 'job spec: an object with a "data" key sets options from its sibling fields.'
                : 'raw data: the whole item becomes the job payload, untouched.'}
            </span>
          </fieldset>
          <p className="mt-2 text-xs text-faint">
            Accepts a JSON array, a single object, or newline-delimited JSON.
          </p>
          <div className="mt-2 text-sm">
            {error ? (
              <span role="alert" className="text-danger">
                {error}
              </span>
            ) : items.length > MAX_JOBS ? (
              <span role="alert" className="text-danger">
                Too many jobs ({items.length}). Limit is {MAX_JOBS}.
              </span>
            ) : items.length > 0 ? (
              <span className="text-success">{items.length} job(s) parsed ✓</span>
            ) : (
              <span className="text-faint">Nothing parsed yet.</span>
            )}
          </div>
          {!error && items.length > 0 && !importValidation.ok && (
            <p role="alert" className="mt-2 text-xs text-danger">
              Import blocked — {importValidation.msg}. Fix the spec or switch to “raw” when the
              whole object is job data.
            </p>
          )}
        </Card>

        <Card>
          <CardHeader title="Target & defaults" />
          <div className="flex flex-col gap-4">
            <Field label="Queue">
              <Input
                list="bulk-queue-options"
                aria-label="Queue"
                name="bulk-target-queue"
                autoComplete="off"
                value={queue}
                onChange={(e) => setQueue(e.target.value)}
                placeholder="queue name (existing or new)"
              />
              <datalist id="bulk-queue-options">
                {(qs?.queues ?? []).map((x) => (
                  <option key={x.name} value={x.name} />
                ))}
              </datalist>
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
            <p className="-mt-2 text-xs text-faint">Defaults below fill any field an item omits.</p>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Priority">
                <Input
                  type="number"
                  min={-1_000_000}
                  max={1_000_000}
                  step={1}
                  name="default-priority"
                  value={priority}
                  onChange={(e) => setPriority(e.target.value)}
                  placeholder="0"
                />
              </Field>
              <Field label="Max attempts">
                <Input
                  type="number"
                  min={1}
                  max={1000}
                  step={1}
                  name="default-max-attempts"
                  value={maxAttempts}
                  onChange={(e) => setMaxAttempts(e.target.value)}
                  placeholder="3"
                />
              </Field>
              <Field label="Backoff (ms)">
                <Input
                  type="number"
                  min={0}
                  max={MAX_DURATION_MS}
                  step={1}
                  name="default-backoff"
                  value={backoff}
                  onChange={(e) => setBackoff(e.target.value)}
                  placeholder="1000"
                />
              </Field>
              <Field label="Timeout (ms)">
                <Input
                  type="number"
                  min={0}
                  max={MAX_DURATION_MS}
                  step={1}
                  name="default-timeout"
                  value={timeout}
                  onChange={(e) => setTimeout(e.target.value)}
                  placeholder="—"
                />
              </Field>
            </div>
            <div className="flex items-center gap-3">
              <Button
                variant="accent"
                disabled={
                  busy ||
                  items.length === 0 ||
                  items.length > MAX_JOBS ||
                  error != null ||
                  !importValidation.ok
                }
                onClick={submit}
              >
                {busy ? 'Importing…' : `Import ${items.length || ''}`}
              </Button>
            </div>
            {result && (
              <span
                role={result.ok ? 'status' : 'alert'}
                className={result.ok ? 'text-sm text-success' : 'text-sm text-danger'}
              >
                {result.msg}
              </span>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
