import { readLimitedJsonBody } from '../server/jsonBody';

const MAX_BODY_BYTES = 8 * 1024;
const MAX_PAGE_INDEX = 10_000;
const MAX_EVENT_RETENTION = 1_000_000;

export function exactQuery(url: string, allowed: readonly string[]): URLSearchParams {
  const query = new URL(url).searchParams;
  for (const key of query.keys()) {
    if (!allowed.includes(key)) throw new Error(`Unknown Queue operation option: ${key}`);
    if (query.getAll(key).length !== 1) {
      throw new Error(`Duplicate Queue operation option: ${key}`);
    }
  }
  return query;
}

export function validateQueueName(queue: string): string {
  if (
    !queue ||
    queue === '.' ||
    queue === '..' ||
    queue.length > 256 ||
    !/^[a-zA-Z0-9_\-.:]+$/.test(queue)
  ) {
    throw new Error('Queue name must contain 1-256 letters, numbers, underscores, dashes, dots or colons');
  }
  return queue;
}

export function requiredDeduplicationId(value: string | null): string {
  if (!value || value.length > 1024) {
    throw new Error('Deduplication ID must contain 1-1024 characters');
  }
  return value;
}

export function optionalMaxJobs(query: URLSearchParams): number | undefined {
  const raw = query.get('maxJobs');
  return raw === null ? undefined : boundedInteger(raw, 'maxJobs', 0, 1_000_000);
}

export function optionalMaxCount(query: URLSearchParams): number | undefined {
  const raw = query.get('maxCount');
  return raw === null ? undefined : boundedInteger(raw, 'maxCount', 1, 1_000_000);
}

export function groupJobsRange(query: URLSearchParams): { start: number; end: number } {
  const start = optionalInteger(query.get('start'), 'start', 0, 1_000_000, 0);
  const end = optionalInteger(query.get('end'), 'end', 0, 1_000_000, start + 24);
  if (end < start) throw new Error('Group jobs end must be at least start');
  if (end - start >= 100) throw new Error('Group jobs page must contain at most 100 jobs');
  return { start, end };
}

export function requiredGroupId(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 256 || value.includes('\0')) {
    throw new Error('groupId must be a non-empty string of at most 256 characters without NUL');
  }
  return value;
}

export function positiveSafeInteger(value: unknown, label: string): number {
  return bodyInteger(value, label, 1, Number.MAX_SAFE_INTEGER);
}

export function metricsRange(query: URLSearchParams): { start: number; end: number } {
  const start = optionalInteger(query.get('start'), 'start', 0, MAX_PAGE_INDEX, 0);
  const rawEnd = query.get('end');
  const end = rawEnd === null ? -1 : boundedInteger(rawEnd, 'end', -1, MAX_PAGE_INDEX);
  if (end !== -1 && end < start) throw new Error('Metrics end must be -1 or at least start');
  return { start, end };
}

export function eventRetention(value: unknown): number {
  return bodyInteger(value, 'maxLength', 0, MAX_EVENT_RETENTION);
}

export async function exactJsonBody(
  request: Request,
  allowed: readonly string[]
): Promise<Record<string, unknown>> {
  const value = await readLimitedJsonBody(request, {
    scope: 'Queue operation',
    maxBytes: MAX_BODY_BYTES,
    limitLabel: '8 KiB',
    missingMessage: 'Queue operation request must be valid JSON',
    invalidJsonMessage: 'Queue operation request must be valid JSON',
  });
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Queue operation request must be an object');
  }
  const body = value as Record<string, unknown>;
  const unknown = Object.keys(body).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`Unknown Queue operation body field: ${unknown}`);
  return body;
}

function optionalInteger(
  value: string | null,
  label: string,
  minimum: number,
  maximum: number,
  fallback: number
): number {
  return value === null ? fallback : boundedInteger(value, label, minimum, maximum);
}

function boundedInteger(
  raw: string,
  label: string,
  minimum: number,
  maximum: number
): number {
  if (!/^-?\d+$/.test(raw)) throw new Error(`${label} must be an integer`);
  return bodyInteger(Number(raw), label, minimum, maximum);
}

function bodyInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}
