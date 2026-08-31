import { jsonResponse } from './responses';
import type { Json } from './shared';

export type MetricType = 'completed' | 'failed';
export type RateLimit = { max: number; duration: number } | null;

export interface GroupState {
  jobs: number;
  active: number;
  consumedJobs: number;
  cooldownMs: number;
  rateLimit: RateLimit;
  concurrency: number | null;
}

export interface QueueState {
  rateLimit: RateLimit;
  concurrency: number | null;
  activeJobs: number;
  consumedJobs: number;
  cooldownMs: number;
  events: number;
  completed: readonly number[];
  failed: readonly number[];
  deduplications: Map<string, string>;
  groups: Map<string, GroupState>;
}

const MAX_BODY_BYTES = 8 * 1024;
const METRIC_TIMESTAMP = 1_783_035_039_000;

export function metricSnapshot(data: readonly number[], start: number, end: number): Json {
  const exclusiveEnd = end === -1 ? data.length : Math.min(data.length, end + 1);
  return {
    meta: {
      count: data.reduce((total, value) => total + value, 0),
      prevTS: data.length ? METRIC_TIMESTAMP : 0,
      prevCount: data[0] ?? 0,
    },
    data: start >= exclusiveEnd ? [] : data.slice(start, exclusiveEnd),
    count: data.length,
  };
}

export function exactQuery(request: Request, allowed: readonly string[]): URLSearchParams {
  const query = new URL(request.url).searchParams;
  for (const key of query.keys()) {
    if (!allowed.includes(key)) throw new Error(`Unknown Queue operation option: ${key}`);
    if (query.getAll(key).length !== 1) throw new Error(`Duplicate Queue operation option: ${key}`);
  }
  if (!query.get('target')) throw new Error('Queue operation target is required');
  return query;
}

export async function exactBody(
  request: Request,
  allowed: readonly string[]
): Promise<Record<string, unknown>> {
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    throw new Error('Queue operation request body exceeds 8 KiB');
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Queue operation request must be valid JSON');
  }
  if (!isRecord(value)) throw new Error('Queue operation request must be an object');
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`Unknown Queue operation body field: ${unknown}`);
  return value;
}

export function validQueue(queue: string): string {
  if (
    !queue ||
    queue.length > 256 ||
    queue === '.' ||
    queue === '..' ||
    !/^[\w.:-]+$/.test(queue)
  ) {
    throw new Error(
      'Queue name must contain 1-256 letters, numbers, underscores, dashes, dots or colons'
    );
  }
  return queue;
}

export function deduplicationId(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 1024) {
    throw new Error('Deduplication ID must contain 1-1024 characters');
  }
  return value;
}

export function groupId(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 256 || value.includes('\0')) {
    throw new Error('groupId must be a non-empty string of at most 256 characters without NUL');
  }
  return value;
}

export function groupFor(state: QueueState, id: string): GroupState {
  const existing = state.groups.get(id);
  if (existing) return existing;
  const group = {
    jobs: 0,
    active: 0,
    consumedJobs: 0,
    cooldownMs: 0,
    rateLimit: null,
    concurrency: null,
  };
  state.groups.set(id, group);
  return group;
}

export function positiveSafeInteger(value: unknown, label: string): number {
  return bodyInteger(value, label, 1, Number.MAX_SAFE_INTEGER);
}

export function metricType(value: string | null): MetricType {
  if (value !== 'completed' && value !== 'failed') {
    throw new Error('Metrics type must be completed or failed');
  }
  return value;
}

export function optionalInteger(
  raw: string | null,
  label: string,
  minimum: number,
  maximum: number
): number | undefined {
  if (raw === null) return undefined;
  if (!/^-?\d+$/.test(raw)) throw new Error(`${label} must be an integer`);
  return bodyInteger(Number(raw), label, minimum, maximum);
}

export function bodyInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function notFound(): Response {
  return jsonResponse({ ok: false, error: 'Unknown Queue operation' }, 404);
}

export const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
