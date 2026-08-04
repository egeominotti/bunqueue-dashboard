import { jsonResponse } from './responses';
import type { Json } from './shared';

type MetricType = 'completed' | 'failed';
type RateLimit = { max: number; duration: number } | null;

interface QueueSeed {
  rateLimit: RateLimit;
  concurrency: number | null;
  activeJobs: number;
  consumedJobs: number;
  cooldownMs: number;
  events: number;
  completed: readonly number[];
  failed: readonly number[];
  deduplications: readonly (readonly [string, string])[];
}

interface QueueState extends Omit<QueueSeed, 'deduplications'> {
  deduplications: Map<string, string>;
}

const QUEUES: Readonly<Record<string, QueueSeed>> = {
  emails: {
    rateLimit: null,
    concurrency: 10,
    activeJobs: 0,
    consumedJobs: 0,
    cooldownMs: 0,
    events: 1_284,
    completed: [2, 1, 0, 1],
    failed: [1, 0, 1],
    deduplications: [['welcome:user8@example.com', '019f252b-86c0-7000-a54e-3816c968ebf0']],
  },
  'image-processing': {
    rateLimit: { max: 100, duration: 60_000 },
    concurrency: 4,
    activeJobs: 2,
    consumedJobs: 100,
    cooldownMs: 750,
    events: 1_428,
    completed: [7, 9, 4, 6, 3],
    failed: [0, 1, 0, 0, 1],
    deduplications: [['asset:hero', '019f252b-8769-7000-bc44-cfc168232f53']],
  },
  reports: {
    rateLimit: null,
    concurrency: 2,
    activeJobs: 0,
    consumedJobs: 0,
    cooldownMs: 0,
    events: 318,
    completed: [1, 0, 2],
    failed: [1],
    deduplications: [],
  },
  notifications: {
    rateLimit: null,
    concurrency: 8,
    activeJobs: 0,
    consumedJobs: 0,
    cooldownMs: 0,
    events: 612,
    completed: [5, 4, 3],
    failed: [],
    deduplications: [],
  },
};

const EMPTY_QUEUE: QueueSeed = {
  rateLimit: null,
  concurrency: null,
  activeJobs: 0,
  consumedJobs: 0,
  cooldownMs: 0,
  events: 0,
  completed: [],
  failed: [],
  deduplications: [],
};

const MAX_BODY_BYTES = 8 * 1024;
const MAX_PAGE_INDEX = 10_000;
const MAX_EVENT_RETENTION = 1_000_000;
const METRIC_TIMESTAMP = 1_783_035_039_000;

export type DemoQueueOperations = (request: Request, path: string) => Promise<Response>;

/** Creates an isolated Queue SDK session so reinstalling the demo resets its mutations. */
export function createDemoQueueOperations(): DemoQueueOperations {
  const states = new Map<string, QueueState>();
  const stateFor = (queue: string): QueueState => {
    const existing = states.get(queue);
    if (existing) return existing;
    const seed = QUEUES[queue] ?? EMPTY_QUEUE;
    const state = { ...seed, deduplications: new Map(seed.deduplications) };
    states.set(queue, state);
    return state;
  };

  return async (request, path) => {
    try {
      const body = await routeRequest(request, path, stateFor);
      return body ? jsonResponse(body) : notFound();
    } catch (error) {
      return jsonResponse({ ok: false, error: messageOf(error) }, 400);
    }
  };
}

async function routeRequest(
  request: Request,
  path: string,
  stateFor: (queue: string) => QueueState
): Promise<Json | null> {
  const segments = path.replace(/\/+$/, '').split('/').filter(Boolean);
  if (segments[0] !== 'queue-operations' || segments.length < 3) return null;
  const queue = validQueue(decodeURIComponent(segments[1]));
  const operation = segments.slice(2).join('/');
  const state = stateFor(queue);

  if (request.method === 'GET' && operation === 'limits') {
    const query = exactQuery(request, ['target', 'maxJobs']);
    const maxJobs = optionalInteger(query.get('maxJobs'), 'maxJobs', 0, 1_000_000);
    const rateLimitTtl =
      state.rateLimit === null
        ? -2
        : maxJobs !== undefined && state.consumedJobs < maxJobs
          ? 0
          : state.cooldownMs;
    return {
      ok: true,
      limits: {
        rateLimit: state.rateLimit,
        concurrency: state.concurrency,
        rateLimitTtl,
        maxed: state.concurrency !== null && state.activeJobs >= state.concurrency,
      },
    };
  }
  if (request.method === 'GET' && operation === 'deduplication') {
    const query = exactQuery(request, ['target', 'deduplicationId']);
    const id = deduplicationId(query.get('deduplicationId'));
    return { ok: true, jobId: state.deduplications.get(id) ?? null };
  }
  if (request.method === 'GET' && operation === 'metrics') {
    const query = exactQuery(request, ['target', 'type', 'start', 'end']);
    const type = metricType(query.get('type'));
    const start = optionalInteger(query.get('start'), 'start', 0, MAX_PAGE_INDEX) ?? 0;
    const end = optionalInteger(query.get('end'), 'end', -1, MAX_PAGE_INDEX) ?? -1;
    if (end !== -1 && end < start) throw new Error('Metrics end must be -1 or at least start');
    return { ok: true, metrics: metricSnapshot(state[type], start, end) };
  }
  if (request.method === 'POST' && operation === 'deduplication/remove') {
    exactQuery(request, ['target']);
    const body = await exactBody(request, ['deduplicationId']);
    const id = deduplicationId(body.deduplicationId);
    return { ok: true, removed: state.deduplications.delete(id) ? 1 : 0 };
  }
  if (request.method === 'POST' && operation === 'events/trim') {
    exactQuery(request, ['target']);
    const body = await exactBody(request, ['maxLength']);
    const maxLength = bodyInteger(body.maxLength, 'maxLength', 0, MAX_EVENT_RETENTION);
    const removed = Math.max(0, state.events - maxLength);
    state.events -= removed;
    return { ok: true, removed };
  }
  return null;
}

function metricSnapshot(data: readonly number[], start: number, end: number): Json {
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

function exactQuery(request: Request, allowed: readonly string[]): URLSearchParams {
  const query = new URL(request.url).searchParams;
  for (const key of query.keys()) {
    if (!allowed.includes(key)) throw new Error(`Unknown Queue operation option: ${key}`);
    if (query.getAll(key).length !== 1) throw new Error(`Duplicate Queue operation option: ${key}`);
  }
  if (!query.get('target')) throw new Error('Queue operation target is required');
  return query;
}

async function exactBody(
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

function validQueue(queue: string): string {
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

function deduplicationId(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 1024) {
    throw new Error('Deduplication ID must contain 1-1024 characters');
  }
  return value;
}

function metricType(value: string | null): MetricType {
  if (value !== 'completed' && value !== 'failed') {
    throw new Error('Metrics type must be completed or failed');
  }
  return value;
}

function optionalInteger(
  raw: string | null,
  label: string,
  minimum: number,
  maximum: number
): number | undefined {
  if (raw === null) return undefined;
  if (!/^-?\d+$/.test(raw)) throw new Error(`${label} must be an integer`);
  return bodyInteger(Number(raw), label, minimum, maximum);
}

function bodyInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function notFound(): Response {
  return jsonResponse({ ok: false, error: 'Unknown Queue operation' }, 404);
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
