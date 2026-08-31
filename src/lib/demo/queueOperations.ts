import {
  bodyInteger,
  deduplicationId,
  exactBody,
  exactQuery,
  groupFor,
  groupId,
  messageOf,
  metricSnapshot,
  metricType,
  notFound,
  optionalInteger,
  positiveSafeInteger,
  type QueueState,
  type RateLimit,
  validQueue,
} from './queueOperationHelpers';
import { jsonResponse } from './responses';
import type { Json } from './shared';

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

const MAX_PAGE_INDEX = 10_000;
const MAX_EVENT_RETENTION = 1_000_000;

export type DemoQueueOperations = (request: Request, path: string) => Promise<Response>;

/** Creates an isolated Queue SDK session so reinstalling the demo resets its mutations. */
export function createDemoQueueOperations(): DemoQueueOperations {
  const states = new Map<string, QueueState>();
  const stateFor = (queue: string): QueueState => {
    const existing = states.get(queue);
    if (existing) return existing;
    const seed = QUEUES[queue] ?? EMPTY_QUEUE;
    const state = { ...seed, deduplications: new Map(seed.deduplications), groups: new Map() };
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
  if (request.method === 'GET' && operation === 'groups') {
    const query = exactQuery(request, ['target', 'groupId', 'maxJobs', 'maxCount']);
    const id = groupId(query.get('groupId'));
    const maxJobs = optionalInteger(query.get('maxJobs'), 'maxJobs', 0, 1_000_000);
    optionalInteger(query.get('maxCount'), 'maxCount', 1, 1_000_000);
    const group = groupFor(state, id);
    const rateLimitTtl =
      group.rateLimit === null
        ? -2
        : maxJobs !== undefined && group.consumedJobs < maxJobs
          ? 0
          : group.cooldownMs;
    return {
      ok: true,
      group: {
        jobs: group.jobs,
        active: group.active,
        totalGrouped: [...state.groups.values()].reduce((sum, item) => sum + item.jobs, 0),
        rateLimit: group.rateLimit,
        rateLimitTtl,
        concurrency: group.concurrency,
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
  if (request.method === 'POST' && operation.startsWith('groups/')) {
    exactQuery(request, ['target']);
    const remove = operation.endsWith('/remove');
    const rateLimit = operation.includes('/rate-limit');
    const allowed = remove
      ? ['groupId']
      : rateLimit
        ? ['groupId', 'max', 'duration']
        : ['groupId', 'concurrency'];
    const body = await exactBody(request, allowed);
    const group = groupFor(state, groupId(body.groupId));
    if (remove) {
      const existed = rateLimit ? group.rateLimit !== null : group.concurrency !== null;
      if (rateLimit) group.rateLimit = null;
      else group.concurrency = null;
      return { ok: true, removed: existed ? 1 : 0 };
    }
    if (rateLimit) {
      group.rateLimit = {
        max: positiveSafeInteger(body.max, 'max'),
        duration: positiveSafeInteger(body.duration, 'duration'),
      };
    } else {
      group.concurrency = positiveSafeInteger(body.concurrency, 'concurrency');
    }
    return { ok: true, applied: true };
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
