/**
 * Demo backend. Patches `window.fetch` (and, since the SSE reader is fetch-based,
 * the live activity stream too) to answer every bunqueue API call from a bundled
 * fixture captured from a real bunqueue 2.8.26 server. No network, no server.
 *
 * Loaded lazily by `main.tsx` only when {@link isDemo} is true, so neither this
 * module nor its ~21 KB fixture is part of the normal app bundle.
 */
import fixtures from './fixtures.json';

type Json = Record<string, unknown>;
const F = fixtures as unknown as Record<string, Json>;

// First path segment of a bunqueue API request. Anything else (assets, etc.) is
// passed through to the real fetch untouched.
const API_ROOTS = new Set([
  'events',
  'health',
  'ping',
  'stats',
  'storage',
  'dashboard',
  'queues',
  'jobs',
  'crons',
  'webhooks',
  'workers',
  'dlq',
  'control',
  'db',
]);

/** Map a normalized API path + method to a fixture response body. */
function resolve(path: string, method: string, search: string): Json {
  const clean = path.replace(/\/+$/, '') || '/';
  const seg = clean.split('/').filter(Boolean);

  if (method !== 'GET') {
    // Mutations "succeed" without mutating the static dataset (this is a demo).
    if (clean.endsWith('/jobs') || clean.endsWith('/jobs/bulk')) {
      return { ok: true, id: `demo-${seg.join('-')}`, ids: ['demo-1'] };
    }
    return { ok: true };
  }

  const exact: Record<string, string> = {
    '/health': 'health',
    '/ping': 'ping',
    '/stats': 'stats',
    '/storage': 'storage',
    '/dashboard': 'dashboard',
    '/dashboard/queues': 'dashboardQueues',
    '/queues/summary': 'queuesSummary',
    '/crons': 'crons',
    '/webhooks': 'webhooks',
    '/workers': 'workers',
    '/dlq/stats': 'dlqStats',
  };
  if (exact[clean]) return F[exact[clean]];

  // /dashboard/queues/:q
  if (seg[0] === 'dashboard' && seg[1] === 'queues' && seg[2]) {
    return F[`detail_${seg[2]}`] ?? F.detail_emails;
  }

  // /queues/:q/(counts | dlq | jobs/list)
  if (seg[0] === 'queues' && seg[1]) {
    const q = seg[1];
    if (seg[2] === 'counts') return F[`counts_${q}`] ?? { ok: true, counts: {} };
    if (seg[2] === 'dlq') return F[`dlq_${q}`] ?? { ok: true, entries: [], total: 0 };
    if (seg[2] === 'jobs' && seg[3] === 'list') {
      const state = new URLSearchParams(search).get('state');
      if (q === 'emails' && state === 'completed') return F.emailsCompleted;
      if (q === 'emails') return F.emailsWaiting;
      return { ok: true, jobs: [] };
    }
  }

  // /jobs/:id and subresources
  if (seg[0] === 'jobs' && seg[1]) {
    if (seg[2] === 'result') return { ok: true, result: { sent: true, provider: 'demo' } };
    if (seg[2] === 'logs') return { ok: true, logs: [] };
    if (!seg[2]) return F.oneJob;
  }

  return { ok: true };
}

const json = (body: Json): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

/** An always-open SSE stream that emits a handshake then periodic job events. */
function sseResponse(signal?: AbortSignal | null): Response {
  const enc = new TextEncoder();
  const queues = ['emails', 'image-processing', 'reports', 'notifications'];
  const kinds = [
    'job:active',
    'job:completed',
    'job:completed',
    'job:waiting',
    'job:failed',
    'job:active',
  ];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let n = 0;
      let closed = false;
      let timer: ReturnType<typeof setInterval>;
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      controller.enqueue(enc.encode('data: {"connected":true}\n\n'));
      timer = setInterval(() => {
        if (closed) return;
        const kind = kinds[n % kinds.length];
        const queue = queues[n % queues.length];
        const data = JSON.stringify({
          queue,
          jobId: `demo-${n}`,
          name: queue,
          timestamp: Date.now(),
        });
        try {
          controller.enqueue(enc.encode(`event: ${kind}\ndata: ${data}\n\n`));
        } catch {
          close();
        }
        n += 1;
      }, 1400);
      if (signal?.aborted) close();
      else signal?.addEventListener('abort', close, { once: true });
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

let installed = false;

export function installDemo(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const realFetch = window.fetch.bind(window);
  const base = (import.meta.env.BASE_URL || '/').replace(/\/+$/, '');

  window.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : null;
    const rawUrl =
      typeof input === 'string' ? input : input instanceof URL ? input.href : (req?.url ?? '');
    const method = (init?.method ?? req?.method ?? 'GET').toUpperCase();

    let u: URL;
    try {
      u = new URL(rawUrl, window.location.origin);
    } catch {
      return realFetch(input, init);
    }

    let path = u.pathname;
    if (base && path.startsWith(base)) path = path.slice(base.length) || '/';
    if (path.startsWith('/api')) path = path.slice(4) || '/';

    const root = path.split('/').filter(Boolean)[0];
    if (!root || !API_ROOTS.has(root)) return realFetch(input, init);

    if (root === 'events') return Promise.resolve(sseResponse(init?.signal ?? req?.signal));
    return Promise.resolve(json(resolve(path, method, u.search)));
  }) as typeof window.fetch;
}
