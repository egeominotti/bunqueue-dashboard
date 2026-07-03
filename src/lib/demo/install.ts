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

// The Database page drives the agent's read-only SQLite inspector (/db/*). The
// agent isn't present in the demo, so synthesize a small, valid database so the
// inspector is fully explorable rather than empty/broken.
const DB_INFO = {
  ok: true,
  sqliteVersion: '3.45.1',
  pageSize: 4096,
  pageCount: 640,
  journalMode: 'wal',
  freelistPages: 8,
  tables: 6,
  indexes: 11,
  fileSize: 2621440,
  walSize: 49152,
};
const DB_TABLES = {
  ok: true,
  tables: [
    { name: 'jobs', rows: 34, columns: 6 },
    { name: 'queues', rows: 4, columns: 4 },
    { name: 'dlq', rows: 2, columns: 5 },
    { name: 'crons', rows: 2, columns: 5 },
    { name: 'webhooks', rows: 1, columns: 6 },
    { name: 'job_results', rows: 4, columns: 3 },
  ],
};
const DB_DATA: Record<
  string,
  { columns: string[]; types: Record<string, string>; rows: unknown[][] }
> = {
  jobs: {
    columns: ['id', 'queue', 'state', 'priority', 'attempts', 'created_at'],
    types: {
      id: 'TEXT',
      queue: 'TEXT',
      state: 'TEXT',
      priority: 'INTEGER',
      attempts: 'INTEGER',
      created_at: 'INTEGER',
    },
    rows: [
      ['019f252b-86c0-7000-a54e-3816c968ebf0', 'emails', 'prioritized', 1, 0, 1783035037376],
      ['019f252b-8769-7000-bc44-cfc168232f53', 'image-processing', 'active', 0, 0, 1783035037545],
      ['019f252b-86da-7000-a9e3-6b1b74944d70', 'emails', 'completed', 3, 0, 1783035037402],
      ['019f252b-8716-7000-bbec-d8c65e09f340', 'emails', 'failed', 3, 0, 1783035037462],
      ['019f252b-87d8-7000-8f0c-e8ca5fec7d18', 'reports', 'delayed', 0, 0, 1783035037656],
    ],
  },
  queues: {
    columns: ['name', 'paused', 'concurrency', 'rate_limit'],
    types: { name: 'TEXT', paused: 'INTEGER', concurrency: 'INTEGER', rate_limit: 'INTEGER' },
    rows: [
      ['emails', 0, 10, 0],
      ['image-processing', 0, 4, 100],
      ['reports', 0, 2, 0],
      ['notifications', 0, 8, 0],
    ],
  },
};

function dbSchema(table: string): Json {
  const t = DB_DATA[table];
  const cols = t?.columns ?? ['id', 'data'];
  const types = t?.types ?? {};
  return {
    ok: true,
    table,
    columns: cols.map((name, i) => ({
      name,
      type: types[name] ?? 'TEXT',
      notNull: i === 0,
      defaultValue: null,
      primaryKey: i === 0,
    })),
    indexes: [{ name: `idx_${table}_${cols[0]}`, unique: true, columns: [cols[0]] }],
    sql: `CREATE TABLE ${table} (${cols.map((c) => `${c} ${types[c] ?? 'TEXT'}`).join(', ')})`,
    rowCount: t?.rows.length ?? 0,
  };
}

function dbRows(table: string, search: string): Json {
  const t = DB_DATA[table];
  const columns = t?.columns ?? ['id', 'data'];
  const rows = t?.rows ?? [];
  const sp = new URLSearchParams(search);
  return {
    ok: true,
    table,
    columns,
    rows,
    rowids: rows.map((_, i) => i + 1),
    truncatedCells: rows.map((r) => r.map(() => false)),
    total: rows.length,
    limit: Number(sp.get('limit') ?? 50),
    offset: Number(sp.get('offset') ?? 0),
    orderBy: sp.get('orderBy'),
    dir: sp.get('dir') === 'desc' ? 'desc' : 'asc',
    filter: null,
  };
}

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
    if (clean.endsWith('/db/query')) {
      return {
        ok: true,
        columns: ['note'],
        rows: [['This is the demo. Queries run against a static in-memory sample.']],
        rowCount: 1,
        truncated: false,
        ms: 0.4,
      };
    }
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

  // /queues/:q/(counts | dlq | dlq/stats | jobs/list)
  if (seg[0] === 'queues' && seg[1]) {
    const q = seg[1];
    if (seg[2] === 'counts') return F[`counts_${q}`] ?? { ok: true, counts: {} };
    if (seg[2] === 'dlq' && seg[3] === 'stats') {
      return { ok: true, stats: { total: q === 'emails' ? 2 : 0, byReason: { unknown: 2 } } };
    }
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

  // /db/* — the read-only SQLite inspector (served by the agent, faked here).
  if (seg[0] === 'db') {
    if (seg[1] === 'info') return DB_INFO;
    if (seg[1] === 'tables' && !seg[2]) return DB_TABLES;
    if (seg[1] === 'tables' && seg[2]) {
      const table = decodeURIComponent(seg[2]);
      if (seg[3] === 'schema') return dbSchema(table);
      if (seg[3] === 'cell') return { ok: true, value: 'demo cell value' };
      return dbRows(table, search);
    }
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

    // Strip the SPA base and a leading /api, but only on a path-segment boundary
    // so a resource like /apihealth is never mis-stripped into an API root.
    let path = u.pathname;
    if (base && (path === base || path.startsWith(`${base}/`)))
      path = path.slice(base.length) || '/';
    if (path === '/api' || path.startsWith('/api/')) path = path.slice(4) || '/';

    const root = path.split('/').filter(Boolean)[0];
    if (!root || !API_ROOTS.has(root)) return realFetch(input, init);

    if (root === 'events') return Promise.resolve(sseResponse(init?.signal ?? req?.signal));
    return Promise.resolve(json(resolve(path, method, u.search)));
  }) as typeof window.fetch;
}
