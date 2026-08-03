/**
 * Demo backend. Patches `window.fetch` (and, since the SSE reader is fetch-based,
 * the live activity stream too) to answer every bunqueue API call from a bundled
 * representative fixture aligned with bunqueue 2.8.55. No network, no server.
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
  dlq: {
    columns: ['id', 'queue', 'reason', 'attempts', 'entered_at'],
    types: {
      id: 'TEXT',
      queue: 'TEXT',
      reason: 'TEXT',
      attempts: 'INTEGER',
      entered_at: 'INTEGER',
    },
    rows: [
      ['019f252b-8716-7000-bbec-d8c65e09f340', 'emails', 'max attempts reached', 3, 1783035037462],
      ['019f252b-8a02-7000-9b21-4c1f0b7e2a55', 'reports', 'handler threw', 5, 1783035039101],
    ],
  },
  crons: {
    columns: ['name', 'queue', 'pattern', 'tz', 'next_run'],
    types: { name: 'TEXT', queue: 'TEXT', pattern: 'TEXT', tz: 'TEXT', next_run: 'INTEGER' },
    rows: [
      ['nightly-report', 'reports', '0 2 * * *', 'UTC', 1783094400000],
      ['digest-email', 'emails', '*/15 * * * *', 'UTC', 1783035900000],
    ],
  },
  webhooks: {
    columns: ['id', 'url', 'events', 'active', 'failures', 'created_at'],
    types: {
      id: 'TEXT',
      url: 'TEXT',
      events: 'TEXT',
      active: 'INTEGER',
      failures: 'INTEGER',
      created_at: 'INTEGER',
    },
    rows: [
      [
        'wh_9c31',
        'https://hooks.example.com/bunqueue',
        'job:completed,job:failed',
        1,
        0,
        1783034000000,
      ],
    ],
  },
  job_results: {
    columns: ['job_id', 'result', 'stored_at'],
    types: { job_id: 'TEXT', result: 'TEXT', stored_at: 'INTEGER' },
    rows: [
      ['019f252b-86da-7000-a9e3-6b1b74944d70', '{"messageId":"smtp-7712"}', 1783035037999],
      ['019f252b-8769-7000-bc44-cfc168232f53', '{"bytes":184320}', 1783035038220],
      ['019f252b-87d8-7000-8f0c-e8ca5fec7d18', '{"rows":128}', 1783035038511],
      ['019f252b-8a02-7000-9b21-4c1f0b7e2a55', '{"error":"handler threw"}', 1783035039300],
      // Database content is untrusted even in a read-only viewer. Keep one
      // formula-shaped TEXT value so the real demo export exercises the same
      // spreadsheet-injection neutralization as the control agent.
      ['demo-csv-formula', '=SUM(1,2)', 1783035039400],
    ],
  },
};

function demoDbTable(table: string) {
  return Object.hasOwn(DB_DATA, table) ? DB_DATA[table] : undefined;
}

// Derived, never hand-written: the sidebar's advertised row/column counts must
// match what /db/tables/:t and its /schema actually serve, or the inspector
// looks broken (a table listed as "2 rows" that opens empty).
const DB_TABLES = {
  ok: true,
  tables: Object.entries(DB_DATA).map(([name, t]) => ({
    name,
    rows: t.rows.length,
    columns: t.columns.length,
  })),
};

function dbSchema(table: string): Json {
  const t = demoDbTable(table);
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

// A sample job flow so the Flows page (DAG view) is populated in the demo:
// an order fans out to charge / ship / notify; ship has a child label job, and
// notify depends on charge. Keyed by job id; served from GET /jobs/:id.
const DEMO_FLOW: Record<string, Json> = {
  'flow-order-9a3f': {
    id: 'flow-order-9a3f',
    queue: 'orders',
    data: {
      name: 'process-order',
      orderId: 'demo-9a3f',
      __childrenIds: ['flow-charge-1', 'flow-ship-2', 'flow-notify-3'],
    },
    state: 'waiting-children',
    priority: 1,
    parentId: null,
    childrenIds: ['flow-charge-1', 'flow-ship-2', 'flow-notify-3'],
    dependsOn: ['flow-charge-1', 'flow-ship-2', 'flow-notify-3'],
  },
  'flow-charge-1': {
    id: 'flow-charge-1',
    queue: 'payments',
    data: {
      name: 'charge-payment',
      __parentId: 'flow-order-9a3f',
      __parentQueue: 'orders',
    },
    state: 'completed',
    priority: 2,
    parentId: 'flow-order-9a3f',
    childrenIds: [],
    dependsOn: [],
  },
  'flow-ship-2': {
    id: 'flow-ship-2',
    queue: 'shipping',
    data: {
      name: 'ship-order',
      __parentId: 'flow-order-9a3f',
      __parentQueue: 'orders',
      __childrenIds: ['flow-label-4'],
    },
    state: 'waiting-children',
    priority: 1,
    parentId: 'flow-order-9a3f',
    childrenIds: ['flow-label-4'],
    dependsOn: ['flow-label-4'],
  },
  'flow-label-4': {
    id: 'flow-label-4',
    queue: 'shipping',
    data: {
      name: 'create-label',
      __parentId: 'flow-ship-2',
      __parentQueue: 'shipping',
    },
    state: 'waiting',
    priority: 0,
    parentId: 'flow-ship-2',
    childrenIds: [],
    dependsOn: [],
  },
  'flow-notify-3': {
    id: 'flow-notify-3',
    queue: 'emails',
    data: {
      name: 'notify-customer',
      __parentId: 'flow-order-9a3f',
      __parentQueue: 'orders',
    },
    state: 'delayed',
    priority: 0,
    parentId: 'flow-order-9a3f',
    childrenIds: [],
    dependsOn: ['flow-charge-1'],
  },
};

const fixtureJobs = (key: string): Json[] => (F[key] as { jobs?: Json[] })?.jobs ?? [];
const DEMO_FALLBACK_JOB = (F.oneJob as { job?: Json }).job;
const DEMO_JOB_POOL: Json[] = [
  ...fixtureJobs('emailsWaiting'),
  ...fixtureJobs('emailsCompleted'),
  ...(DEMO_FALLBACK_JOB ? [DEMO_FALLBACK_JOB] : []),
];
const DEMO_QUEUE_NAMES = ['emails', 'image-processing', 'reports', 'notifications'];

function retagDemoJob(job: Json, queue: string, index: number): Json {
  return queue === 'emails'
    ? job
    : { ...job, id: `${queue}-${String(job.id).slice(-12)}-${index}`, queue };
}

/** Return the same canonical id/state snapshot that a demo list links to. */
function demoJobForId(id: string): Json {
  if (DEMO_FLOW[id]) return DEMO_FLOW[id];
  const exact = DEMO_JOB_POOL.find((job) => job.id === id);
  if (exact) return exact;
  for (const queue of DEMO_QUEUE_NAMES) {
    const retagged = DEMO_JOB_POOL.map((job, index) => retagDemoJob(job, queue, index)).find(
      (job) => job.id === id
    );
    if (retagged) return retagged;
  }

  const fallback = DEMO_FALLBACK_JOB ?? { queue: 'emails', state: 'failed' };
  const customPrefix = 'demo-custom:';
  return {
    ...fallback,
    id,
    customId: id.startsWith(customPrefix) ? id.slice(customPrefix.length) : null,
  };
}

// The control agent (process lifecycle) isn't present in the demo. Synthesize a
// healthy "running" server so ServerControl renders a realistic snapshot rather
// than the empty/shape-mismatched state a bare { ok: true } would produce.
const DEMO_CONFIG = {
  command: 'bunqueue start',
  httpPort: 6790,
  tcpPort: 6791,
  dataPath: './data/bunqueue.db',
  extraEnv: { LOG_LEVEL: 'info' },
};
const demoStatus = (): Json => ({
  status: 'running',
  pid: 42317,
  startedAt: Date.now() - 3_600_000,
  exitCode: null,
  healthy: true,
  version: '2.8.55',
  config: DEMO_CONFIG,
  runningConfig: DEMO_CONFIG,
  db: {
    path: DEMO_CONFIG.dataPath,
    exists: true,
    size: 2_621_440,
    walSize: 49_152,
    shmSize: 32_768,
    totalSize: 2_703_360,
    mtimeMs: Date.now() - 12_000,
  },
});
// Workers carry timestamps the UI compares against Date.now() (last-seen,
// uptime), so they're synthesized here instead of the static fixture — a JSON
// lastSeen would drift into "stale" as the fixture ages.
const demoWorkers = (): Json => {
  const now = Date.now();
  return {
    ok: true,
    data: {
      workers: [
        {
          id: 'wrk-9f21c3d0',
          name: 'worker-emails-1',
          queues: ['emails', 'notifications'],
          concurrency: 10,
          hostname: 'worker-01',
          pid: 3411,
          status: 'active',
          registeredAt: now - 5_400_000,
          lastSeen: now - 4_000,
          activeJobs: 0,
          processedJobs: 1284,
          failedJobs: 6,
          currentJob: null,
          uptime: 5_400_000,
        },
        {
          id: 'wrk-4b77aa19',
          name: 'worker-media-1',
          queues: ['image-processing'],
          concurrency: 4,
          hostname: 'worker-02',
          pid: 3987,
          status: 'active',
          registeredAt: now - 5_100_000,
          lastSeen: now - 2_000,
          activeJobs: 2,
          processedJobs: 342,
          failedJobs: 1,
          currentJob: '019f252b-8769-7000-bc44-cfc168232f53',
          uptime: 5_100_000,
        },
        {
          id: 'wrk-c05e881f',
          name: 'worker-batch-1',
          queues: ['reports'],
          concurrency: 2,
          hostname: 'worker-02',
          pid: 4102,
          status: 'stale',
          registeredAt: now - 9_000_000,
          lastSeen: now - 1_200_000,
          activeJobs: 0,
          processedJobs: 57,
          failedJobs: 0,
          currentJob: null,
          uptime: 7_800_000,
        },
      ],
      stats: { total: 3, active: 2, totalProcessed: 1683, totalFailed: 7, activeJobs: 2 },
    },
  };
};

const demoControlLogs = (): Json => {
  const t = Date.now();
  const line = (seq: number, ago: number, stream: string, line: string) => ({
    seq,
    ts: t - ago,
    stream,
    line,
  });
  return {
    lines: [
      line(1, 8000, 'sys', 'starting: bunqueue start'),
      line(2, 7800, 'stdout', 'bunqueue v2.8.55 — HTTP :6790, TCP :6791'),
      line(3, 7600, 'stdout', 'SQLite ready (WAL) at ./data/bunqueue.db'),
      line(4, 5000, 'stdout', 'worker registered: image-processing'),
      line(5, 1200, 'stdout', 'health ok — 4 queues, 34 jobs'),
    ],
  };
};

type DemoDbFilter = { column: string; op: 'contains' | 'eq' | 'ne'; value: string };

interface DemoDbView {
  table: string;
  columns: string[];
  rows: unknown[][];
  orderBy: string | null;
  dir: 'asc' | 'desc';
  filter: DemoDbFilter | null;
}

const asciiFold = (value: string): string =>
  value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

/** Build the filtered/sorted view used by both the demo grid and raw export. */
function dbView(table: string, search: string, strictExport = false): DemoDbView {
  const t = demoDbTable(table);
  if (strictExport && !t) throw new Error(`No such table: ${table}`);
  const columns = t?.columns ?? ['id', 'data'];
  const all = t?.rows ?? [];
  const sp = new URLSearchParams(search);

  if (strictExport) {
    const allowed = new Set(['orderBy', 'dir', 'fcol', 'fop', 'fval']);
    for (const key of sp.keys()) {
      if (!allowed.has(key)) throw new Error(`Unknown database export option: ${key}`);
      if (sp.getAll(key).length !== 1) {
        throw new Error(`Duplicate database export option: ${key}`);
      }
    }
  }

  const orderByParam = sp.get('orderBy');
  if (strictExport && orderByParam === '') {
    throw new Error('Database export orderBy must not be empty');
  }
  const orderBy = orderByParam || null;
  const dirParam = sp.get('dir');
  if (strictExport && dirParam !== null && dirParam !== 'asc' && dirParam !== 'desc') {
    throw new Error('Database export dir must be "asc" or "desc"');
  }
  const dir: 'asc' | 'desc' = dirParam === 'desc' ? 'desc' : 'asc';

  const fCol = sp.get('fcol');
  const fOp = sp.get('fop');
  const fVal = sp.get('fval');
  const hasAnyFilterPart = fCol !== null || fOp !== null || fVal !== null;
  if (
    strictExport &&
    hasAnyFilterPart &&
    (!fCol || !fVal || (fOp !== 'contains' && fOp !== 'eq' && fOp !== 'ne'))
  ) {
    throw new Error('Database export filter requires valid fcol, fop and fval values');
  }
  const filter: DemoDbFilter | null =
    fCol && fVal
      ? {
          column: fCol,
          op: fOp === 'eq' ? 'eq' : fOp === 'ne' ? 'ne' : 'contains',
          value: fVal,
        }
      : null;

  const filterColumn = filter ? columns.indexOf(filter.column) : -1;
  if (filter && filterColumn < 0 && strictExport) {
    throw new Error(`No such column: ${filter.column}`);
  }
  const filtered =
    filter && filterColumn >= 0
      ? all.filter((row) => {
          const value = row[filterColumn];
          // SQL comparisons against NULL do not pass a WHERE predicate.
          if (value == null) return false;
          const text = String(value);
          if (filter.op === 'eq') return text === filter.value;
          if (filter.op === 'ne') return text !== filter.value;
          // SQLite LIKE is ASCII case-insensitive by default. `%`, `_` and `\`
          // are literal here, matching the agent's escaped contains predicate.
          return asciiFold(text).includes(asciiFold(filter.value));
        })
      : all;

  const sortColumn = orderBy ? columns.indexOf(orderBy) : -1;
  if (orderBy && sortColumn < 0 && strictExport) throw new Error(`No such column: ${orderBy}`);
  const rows =
    sortColumn >= 0
      ? [...filtered].sort((a, b) => {
          const x = a[sortColumn] as string | number | null;
          const y = b[sortColumn] as string | number | null;
          const cmp = x == null ? (y == null ? 0 : -1) : y == null ? 1 : x < y ? -1 : x > y ? 1 : 0;
          return dir === 'desc' ? -cmp : cmp;
        })
      : filtered;

  return {
    table,
    columns,
    rows,
    orderBy: sortColumn >= 0 ? orderBy : null,
    dir,
    filter: filterColumn >= 0 ? filter : null,
  };
}

function dbRows(table: string, search: string): Json {
  const view = dbView(table, search);
  const { columns, orderBy, dir, filter } = view;
  const sp = new URLSearchParams(search);
  const num = (v: string | null, fallback: number): number => {
    const n = Number(v);
    return v !== null && Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  const limit = num(sp.get('limit'), 50);
  const offset = num(sp.get('offset'), 0);
  // Honour orderBy/limit/offset instead of just echoing them back, so sorting or
  // paging the demo grid actually changes what it shows.
  const rows = view.rows.slice(offset, offset + (limit > 0 ? limit : view.rows.length));
  return {
    ok: true,
    table,
    columns,
    rows,
    rowids: rows.map((_, i) => offset + i + 1),
    truncatedCells: rows.map((r) => r.map(() => false)),
    total: view.rows.length,
    limit,
    offset,
    orderBy,
    dir,
    filter,
  };
}

const DEMO_DB_EXPORT_MAX_ROWS = 200_000;
const DEMO_DB_EXPORT_MAX_BYTES = 16 * 1024 * 1024;
const DEMO_DB_EXPORT_MAX_TEXT_BYTES = 2000;
const DEMO_DB_EXPORT_TEXT_PREFIX_CHARS = 2000;

/** RFC-4180 cell with the agent's spreadsheet-formula neutralization. */
function dbCsvCell(value: unknown): string {
  let text: string;
  let textual = false;
  if (value == null) text = '';
  else if (typeof value === 'string') {
    text =
      new TextEncoder().encode(value).byteLength > DEMO_DB_EXPORT_MAX_TEXT_BYTES
        ? `${[...value].slice(0, DEMO_DB_EXPORT_TEXT_PREFIX_CHARS).join('')}…`
        : value;
    textual = true;
  } else if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    text = String(value);
  } else if (value instanceof Uint8Array) {
    text = `<blob ${value.byteLength} B>`;
    textual = true;
  } else {
    throw new Error('Database export produced an unsupported SQLite value');
  }

  const safe = textual && /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** Raw CSV response matching the control-agent database export contract. */
function dbExportResponse(table: string, search: string): Response {
  try {
    const view = dbView(table, search, true);
    const encoder = new TextEncoder();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let rowCount = 0;
    let cap: 'rows' | 'bytes' | null = null;
    const append = (line: string): boolean => {
      const encoded = encoder.encode(line);
      if (bytes + encoded.byteLength > DEMO_DB_EXPORT_MAX_BYTES) return false;
      chunks.push(encoded);
      bytes += encoded.byteLength;
      return true;
    };

    if (!append(view.columns.map(dbCsvCell).join(','))) {
      throw new Error(
        `Database export header exceeds the ${DEMO_DB_EXPORT_MAX_BYTES}-byte export limit`
      );
    }
    for (const row of view.rows) {
      if (rowCount >= DEMO_DB_EXPORT_MAX_ROWS) {
        cap = 'rows';
        break;
      }
      if (!append(`\r\n${row.map(dbCsvCell).join(',')}`)) {
        cap = 'bytes';
        break;
      }
      rowCount++;
    }

    const content = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      content.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new Response(content, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Length': String(bytes),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Bunqueue-Db-Export-Version': '1',
        'X-Bunqueue-Db-Export-Table': encodeURIComponent(view.table),
        'X-Bunqueue-Db-Export-Rows': String(rowCount),
        'X-Bunqueue-Db-Export-Bytes': String(bytes),
        'X-Bunqueue-Db-Export-Cap': cap ?? 'none',
        'Access-Control-Expose-Headers':
          'Content-Length, X-Bunqueue-Db-Export-Version, X-Bunqueue-Db-Export-Table, X-Bunqueue-Db-Export-Rows, X-Bunqueue-Db-Export-Bytes, X-Bunqueue-Db-Export-Cap',
      },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }
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
  'gc',
  'heapstats',
]);

/** Map a normalized API path + method to a fixture response body. */
function resolve(path: string, method: string, search: string): Json {
  const clean = path.replace(/\/+$/, '') || '/';
  const seg = clean.split('/').filter(Boolean);

  // /control/* — process-lifecycle agent, faked for all methods so a start/stop
  // click and the status/logs/config polls all resolve to a coherent snapshot.
  if (seg[0] === 'control') {
    if (seg[1] === 'logs') return demoControlLogs();
    if (seg[1] === 'config') return DEMO_CONFIG;
    return demoStatus(); // status / start / stop / restart
  }

  if (method !== 'GET') {
    // Force-GC returns a plausible before/after so the Diagnostics button shows a
    // reclaim instead of an error in the backend-less demo.
    if (clean === '/gc') {
      return {
        ok: true,
        before: { heapUsed: 118, heapTotal: 176, rss: 214 },
        after: { heapUsed: 94, heapTotal: 150, rss: 181 },
      };
    }
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

  // Workers carry now-relative timestamps — synthesized, not fixture-served.
  if (clean === '/workers') return demoWorkers();

  // Heap breakdown for the Diagnostics panel — plausible static figures.
  if (clean === '/heapstats') {
    return {
      ok: true,
      memory: { heapUsed: 94, heapTotal: 150, rss: 181 },
      heap: { objectCount: 486_204, protectedCount: 1284, globalCount: 312 },
      collections: {},
      topObjectTypes: [
        { type: 'Structure', count: 42_118 },
        { type: 'Object', count: 31_064 },
        { type: 'Function', count: 18_902 },
        { type: 'string', count: 12_447 },
        { type: 'Array', count: 8021 },
      ],
    };
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
    '/dlq/stats': 'dlqStats',
  };
  if (exact[clean]) return F[exact[clean]];

  // /dashboard/queues/:q
  if (seg[0] === 'dashboard' && seg[1] === 'queues' && seg[2]) {
    return F[`detail_${seg[2]}`] ?? F.detail_emails;
  }

  // /queues/:q/(counts | dlq | dlq/stats | jobs/list | stall-config | dlq-config)
  if (seg[0] === 'queues' && seg[1]) {
    const q = decodeURIComponent(seg[1]);
    if (seg[2] === 'counts') return F[`counts_${q}`] ?? { ok: true, counts: {} };
    if (seg[2] === 'dlq' && seg[3] === 'stats') {
      return {
        ok: true,
        stats:
          q === 'emails'
            ? { total: 2, byReason: { timeout: 1, max_attempts: 1 } }
            : { total: 0, byReason: {} },
      };
    }
    if (seg[2] === 'dlq') return F[`dlq_${q}`] ?? { ok: true, entries: [], total: 0 };
    // QueueControl's stall / DLQ-policy cards render only when these resolve.
    if (seg[2] === 'stall-config') {
      return {
        ok: true,
        config: { enabled: true, stallInterval: 30000, maxStalls: 3, gracePeriod: 5000 },
      };
    }
    if (seg[2] === 'dlq-config') {
      return {
        ok: true,
        config: {
          autoRetry: false,
          autoRetryInterval: 60000,
          maxAutoRetries: 3,
          maxAge: null,
          maxEntries: 1000,
        },
      };
    }
    if (seg[2] === 'jobs' && seg[3] === 'list') {
      // The client sends `states` (comma-separated). Filter the fixture pool by
      // the requested states, and retag jobs for non-emails queues so every
      // queue in the demo has browseable jobs rather than an empty table.
      const sp = new URLSearchParams(search);
      const wanted = (sp.get('states') ?? sp.get('state') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const matches = (state: unknown) =>
        wanted.length === 0 ||
        wanted.includes(String(state)) ||
        // The UI's "waiting" bucket includes prioritized jobs.
        (wanted.includes('waiting') && state === 'prioritized');
      return {
        ok: true,
        jobs: DEMO_JOB_POOL.filter((job) => matches(job.state)).map((job, index) =>
          retagDemoJob(job, q, index)
        ),
      };
    }
  }

  // /jobs/:id and subresources
  if (seg[0] === 'jobs' && seg[1]) {
    const jid = decodeURIComponent(seg[1]);
    // /jobs/custom/:customId — resolve a custom/idempotency id to a job.
    if (seg[1] === 'custom' && seg[2]) {
      const customId = decodeURIComponent(seg[2]);
      return { ok: true, job: demoJobForId(`demo-custom:${customId}`) };
    }
    if (seg[2] === 'result') {
      return { ok: true, id: jid, result: { sent: true, provider: 'demo' } };
    }
    if (seg[2] === 'logs') {
      // bq.jobLogs reads { data: { logs, count } }; lines render as strings.
      const logs = [
        '[info] picked up by worker-emails-1',
        '[info] connecting to smtp.example.com:587',
        '[error] SMTP 550: mailbox unavailable — will retry with backoff',
      ];
      return { ok: true, data: { logs, count: logs.length } };
    }
    if (!seg[2]) return { ok: true, job: demoJobForId(jid) };
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

export function installDemo(): () => void {
  if (installed || typeof window === 'undefined') return () => undefined;
  installed = true;
  const previousFetch = window.fetch;
  const realFetch = previousFetch.bind(window);
  const base = (import.meta.env.BASE_URL || '/').replace(/\/+$/, '');

  const demoFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
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
    if (method === 'GET') {
      const seg = path.replace(/\/+$/, '').split('/').filter(Boolean);
      if (seg.length === 4 && seg[0] === 'db' && seg[1] === 'tables' && seg[3] === 'export') {
        return Promise.resolve(dbExportResponse(decodeURIComponent(seg[2]), u.search));
      }
    }
    return Promise.resolve(json(resolve(path, method, u.search)));
  };
  window.fetch = demoFetch as typeof window.fetch;

  // Production keeps the shim for the page lifetime. Returning an idempotent
  // cleanup makes test/watch and embedding lifecycles reversible without
  // exposing module-private state or leaving a permanently `installed` module.
  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    if (window.fetch === demoFetch) window.fetch = previousFetch;
    installed = false;
  };
}
