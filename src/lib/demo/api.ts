import { demoBackupResponse } from './backups';
import { DEMO_CONFIG, demoControlLogs, demoStatus, demoWorkers } from './control';
import { DB_INFO, DB_TABLES, dbSchema } from './databaseFixtures';
import { dbRows } from './databaseView';
import { demoFlowResponse } from './flows';
import { DEMO_JOB_POOL, demoJobForId, retagDemoJob } from './jobs';
import { F, type Json } from './shared';
import { demoWorkflowResponse } from './workflows';

export const API_ROOTS = new Set([
  'events',
  'health',
  'healthz',
  'live',
  'ready',
  'ping',
  'stats',
  'metrics',
  'storage',
  'dashboard',
  'queues',
  'queue-operations',
  'jobs',
  'crons',
  'webhooks',
  'workers',
  'dlq',
  'control',
  'db',
  'workflows',
  'flows',
  'backup',
  'gc',
  'heapstats',
]);

function demoQueueResponse(segments: string[], search: string): Json | null {
  if (segments[0] !== 'queues' || !segments[1]) return null;
  const queue = decodeURIComponent(segments[1]);
  if (segments[2] === 'counts') return F[`counts_${queue}`] ?? { ok: true, counts: {} };
  if (segments[2] === 'dlq' && segments[3] === 'stats') {
    return {
      ok: true,
      stats:
        queue === 'emails'
          ? { total: 2, byReason: { timeout: 1, max_attempts: 1 } }
          : { total: 0, byReason: {} },
    };
  }
  if (segments[2] === 'dlq') {
    return F[`dlq_${queue}`] ?? { ok: true, entries: [], total: 0 };
  }
  if (segments[2] === 'stall-config') {
    return {
      ok: true,
      config: { enabled: true, stallInterval: 30000, maxStalls: 3, gracePeriod: 5000 },
    };
  }
  if (segments[2] === 'dlq-config') {
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
  if (segments[2] !== 'jobs' || segments[3] !== 'list') return null;
  const params = new URLSearchParams(search);
  const wanted = (params.get('states') ?? params.get('state') ?? '')
    .split(',')
    .map((state) => state.trim())
    .filter(Boolean);
  const matches = (state: unknown) =>
    wanted.length === 0 ||
    wanted.includes(String(state)) ||
    (wanted.includes('waiting') && state === 'prioritized');
  return {
    ok: true,
    jobs: DEMO_JOB_POOL.filter((job) => matches(job.state)).map((job, index) =>
      retagDemoJob(job, queue, index)
    ),
  };
}

function demoJobResponse(segments: string[]): Json | null {
  if (segments[0] !== 'jobs' || !segments[1]) return null;
  const id = decodeURIComponent(segments[1]);
  if (segments[1] === 'custom' && segments[2]) {
    const customId = decodeURIComponent(segments[2]);
    return { ok: true, job: demoJobForId(`demo-custom:${customId}`) };
  }
  if (segments[2] === 'result') {
    return { ok: true, id, result: { sent: true, provider: 'demo' } };
  }
  if (segments[2] === 'logs') {
    const logs = [
      '[info] picked up by worker-emails-1',
      '[info] connecting to smtp.example.com:587',
      '[error] SMTP 550: mailbox unavailable — will retry with backoff',
    ];
    return { ok: true, data: { logs, count: logs.length } };
  }
  return segments[2] ? null : { ok: true, job: demoJobForId(id) };
}

function demoDatabaseResponse(segments: string[], search: string): Json | null {
  if (segments[0] !== 'db') return null;
  if (segments[1] === 'info') return DB_INFO;
  if (segments[1] === 'tables' && !segments[2]) return DB_TABLES;
  if (segments[1] !== 'tables' || !segments[2]) return null;
  const table = decodeURIComponent(segments[2]);
  if (segments[3] === 'schema') return dbSchema(table);
  if (segments[3] === 'cell') return { ok: true, value: 'demo cell value' };
  return dbRows(table, search);
}

function mutationResponse(clean: string, segments: string[]): Json {
  if (clean === '/gc') {
    return {
      ok: true,
      before: { heapUsed: 118, heapTotal: 176, rss: 214 },
      after: { heapUsed: 94, heapTotal: 150, rss: 181 },
    };
  }
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
    return { ok: true, id: `demo-${segments.join('-')}`, ids: ['demo-1'] };
  }
  return { ok: true };
}

export function demoApiResponse(path: string, method: string, search: string): Json {
  const clean = path.replace(/\/+$/, '') || '/';
  const segments = clean.split('/').filter(Boolean);

  if (segments[0] === 'control') {
    if (segments[1] === 'logs') return demoControlLogs();
    if (segments[1] === 'config') return DEMO_CONFIG;
    return demoStatus();
  }
  if (segments[0] === 'workflows') return demoWorkflowResponse(segments, search, method);
  if (segments[0] === 'backup') return demoBackupResponse(segments, method);
  if (segments[0] === 'flows') return demoFlowResponse(segments, method, search);
  if (method !== 'GET') return mutationResponse(clean, segments);

  if (clean === '/workers') return demoWorkers();
  if (clean === '/ready') return { ok: true, ready: true };
  if (clean === '/metrics') {
    const stats = F.stats.stats as Record<string, number>;
    return {
      ok: true,
      metrics: {
        totalPushed: stats.totalPushed,
        totalPulled: stats.totalPulled,
        totalCompleted: stats.totalCompleted,
        totalFailed: stats.totalFailed,
      },
    };
  }
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
  if (segments[0] === 'dashboard' && segments[1] === 'queues' && segments[2]) {
    return F[`detail_${segments[2]}`] ?? F.detail_emails;
  }
  return (
    demoQueueResponse(segments, search) ??
    demoJobResponse(segments) ??
    demoDatabaseResponse(segments, search) ?? { ok: true }
  );
}
