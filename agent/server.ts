/**
 * Request handling + origin/auth policy for the control agent, factored out of
 * index.ts so it can be unit-tested without binding a port.
 *
 * Threat model: the agent can spawn arbitrary processes (`/control/config` sets
 * the launch command, `/control/start` runs it). It binds 127.0.0.1, but that
 * does NOT stop a malicious web page the user is visiting from issuing a
 * cross-origin request to http://127.0.0.1:6800 (CSRF → RCE). Defenses:
 *
 *  1. CORS is locked to an explicit allowlist (never `*`); the browser is only
 *     told a cross-origin response is readable for known dashboard origins.
 *  2. Any request carrying a disallowed `Origin` header is rejected (403)
 *     before it can reach the ProcessManager — a cross-origin browser request
 *     always sends `Origin`, so a drive-by page cannot start/stop/reconfigure
 *     the server. Non-browser callers (curl, same-process) send no Origin and
 *     still work for local use.
 *  3. Host-header allowlist (DNS-rebinding defense). The Origin gate does NOT
 *     cover a *same-origin* request: a page whose DNS name is rebound to
 *     127.0.0.1 issues same-origin GETs that carry no `Origin` header, so it
 *     could otherwise read /control/status, /control/logs and the /db/*
 *     inspector (job payloads). When the agent is reachable beyond loopback,
 *     every route also requires the configured token; Host validation remains
 *     necessary because it rejects the rebound request before any data leaves.
 *     When `allowedHosts` is configured, a request whose `Host` header names a
 *     hostname outside the allowlist is rejected (403) — the rebinding page's
 *     `Host` is the attacker's domain, never a loopback/allowlisted host.
 *  4. Optional bearer token (AGENT_TOKEN): on loopback, when set, changing
 *     requests must present it. A network-facing caller must set
 *     `requireTokenForAll`, which protects reads and writes alike.
 */
import {
  type DbFilter,
  dbCell,
  DbExportBusyError,
  DbExportUnavailableError,
  dbInfo,
  dbRows,
  dbSchema,
  dbTables,
  exportWithTimeout,
  MissingDbError,
  queryWithTimeout,
} from './db';
import { type ProcessManager, validateConfigPatch } from './manager';
import {
  type WorkflowStateFilter,
  type WorkflowStoreKind,
  workflowExecution,
  workflowExecutions,
  workflowStats,
  WORKFLOW_STATES,
} from './workflows';

export interface AgentOptions {
  allowedOrigins: string[];
  /**
   * DNS-rebinding defense: when set (non-empty), a request whose `Host` header
   * resolves to a hostname outside this list is rejected. Compared by hostname
   * only (port stripped). Leave undefined only for a loopback-only integration
   * or when a trusted front proxy has already enforced Host. Network-facing
   * listeners must configure this allowlist.
   */
  allowedHosts?: string[];
  /** On loopback, when set, POST/PUT requests must present this token. */
  token?: string;
  /** Network exposure: require `token` on every non-OPTIONS request, including reads. */
  requireTokenForAll?: boolean;
}

const DEFAULT_ORIGINS = ['http://localhost:5273', 'http://127.0.0.1:5273'];

/** Hostnames always trusted as loopback for the Host-header allowlist. */
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1', '0.0.0.0'];

/** Parse AGENT_ALLOWED_ORIGINS (comma-separated) merged with sane dev defaults. */
export function resolveAllowedOrigins(env = process.env): string[] {
  const extra = (env.AGENT_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
  return Array.from(new Set([...DEFAULT_ORIGINS, ...extra]));
}

/**
 * Extract the bare hostname from a `Host` header or an origin/URL (strips a
 * leading scheme and any port, unwraps IPv6 brackets, lowercases).
 */
export function hostnameOf(host: string): string {
  const s = host.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, ''); // drop scheme:// if present
  const v6 = s.match(/^\[([^\]]+)\]/); // [::1]:6800 → ::1
  if (v6) return v6[1].toLowerCase();
  const i = s.indexOf(':');
  if (i === -1) return s.toLowerCase();
  // A bare (unbracketed) IPv6 literal has several colons and no port delimiter:
  // splitting on the first one would both lock the real host out and allowlist a
  // bogus single label ('2001:db8::5' → '2001'). Keep it whole — that also makes
  // hostnameOf idempotent over its own bracket-stripped output.
  if (s.indexOf(':') !== s.lastIndexOf(':')) return s.toLowerCase();
  return s.slice(0, i).toLowerCase();
}

/**
 * Loopback hostnames plus any from AGENT_ALLOWED_HOSTS (comma-separated) and
 * `extra` (hostnames or full origins of the served/allowlisted origins).
 * Reduced to bare hostnames, deduped.
 */
export function resolveAllowedHosts(env = process.env, extra: string[] = []): string[] {
  const fromEnv = (env.AGENT_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((s) => hostnameOf(s.trim()))
    .filter(Boolean);
  const extraHosts = extra.map((s) => hostnameOf(s)).filter(Boolean);
  return Array.from(new Set([...LOOPBACK_HOSTS, ...extraHosts, ...fromEnv]));
}

export function isOriginAllowed(origin: string | null, allowed: string[]): boolean {
  if (!origin) return true; // non-browser caller (curl / same process) — no Origin header
  return allowed.includes(origin.replace(/\/$/, ''));
}

/**
 * Host-header allowlist. Disabled (always true) when `allowed` is undefined.
 * Once enabled it is fail-closed: a real HTTP request always has Host, and
 * accepting a missing one would create an avoidable bypass for unusual proxy
 * paths. A DNS-rebinding page sends its own domain as Host, so it fails too.
 */
export function isHostAllowed(host: string | null, allowed?: string[]): boolean {
  if (!allowed) return true;
  if (!host) return false;
  return allowed.includes(hostnameOf(host));
}

/** CORS headers. ACAO is reflected only for an allowed origin (never `*`). */
export function corsHeaders(origin: string | null, allowed: string[]): Record<string, string> {
  const h: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Agent-Token',
    Vary: 'Origin',
  };
  if (origin && allowed.includes(origin.replace(/\/$/, ''))) {
    h['Access-Control-Allow-Origin'] = origin;
  }
  return h;
}

function tokenOk(req: Request, token?: string): boolean {
  if (!token) return false;
  const auth = req.headers.get('authorization') ?? '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return bearer === token || req.headers.get('x-agent-token') === token;
}

/**
 * Build the fetch handler for the agent. Pure w.r.t. the network — takes a
 * ProcessManager and policy, returns an async (req) => Response.
 */
export function createFetchHandler(mgr: ProcessManager, opts: AgentOptions) {
  const { allowedOrigins, allowedHosts, token, requireTokenForAll = false } = opts;

  const json = (data: unknown, status: number, origin: string | null): Response =>
    new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(origin, allowedOrigins) },
    });

  async function statusWithHealth() {
    const snap = mgr.getStatus();
    let healthy = false;
    let version: string | undefined;
    if (snap.status === 'running') {
      const port = snap.runningConfig?.httpPort ?? snap.config.httpPort;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(1500),
        });
        if (res.ok) {
          const body: unknown = await res.json();
          if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
            const health = body as Record<string, unknown>;
            // HTTP 2xx alone is not a Bunqueue health verdict: an unrelated
            // process, proxy fallback, or malformed payload can also return it.
            // Fail closed unless the semantic health flag is exactly true.
            healthy = health.ok === true;
            if (typeof health.version === 'string') version = health.version;
          }
        }
      } catch {
        /* not up yet */
      }
    }
    const db = await mgr.dbStats().catch(() => null);
    return { ...snap, healthy, version, db };
  }

  return async function handle(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url);
    const method = req.method;
    const origin = req.headers.get('origin');

    // DNS-rebinding defense: reject a same-origin request whose Host header is
    // an attacker domain rebound to loopback (no Origin header would be sent,
    // so the Origin gate below can't see it). No-op when allowedHosts is unset.
    if (!isHostAllowed(req.headers.get('host'), allowedHosts)) {
      return json({ ok: false, error: 'Host not allowed' }, 403, origin);
    }

    // Block any request from a disallowed browser origin before it can act.
    if (!isOriginAllowed(origin, allowedOrigins)) {
      return json({ ok: false, error: 'Origin not allowed' }, 403, origin);
    }

    // Preflight never needs a bearer token, but Host and Origin are security
    // boundaries in their own right and therefore fail closed before this 204.
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin, allowedOrigins) });
    }

    // Preserve zero-config LOOPBACK use: there, reads stay open and a configured
    // token gates mutations. A network-facing listener sets requireTokenForAll,
    // because Origin alone cannot authenticate curl/no-Origin callers and the db
    // inspector contains job payloads. Misconfiguration fails closed: enabling
    // the all-route gate without a token makes every real route answer 401.
    const mutating = method === 'POST' || method === 'PUT';
    const authRequired = requireTokenForAll || (mutating && Boolean(token));
    if (authRequired && !tokenOk(req, token)) {
      return json({ ok: false, error: 'Unauthorized' }, 401, origin);
    }

    try {
      if (pathname === '/control/status') return json(await statusWithHealth(), 200, origin);
      if (pathname === '/control/logs') return json({ lines: mgr.getLogs() }, 200, origin);

      if (pathname === '/control/start' && method === 'POST') {
        await mgr.start();
        return json(await statusWithHealth(), 200, origin);
      }
      if (pathname === '/control/stop' && method === 'POST') {
        await mgr.stop();
        return json(await statusWithHealth(), 200, origin);
      }
      if (pathname === '/control/restart' && method === 'POST') {
        await mgr.restart();
        return json(await statusWithHealth(), 200, origin);
      }

      if (pathname === '/control/config' && method === 'GET') return json(mgr.getConfig(), 200, origin);
      if (pathname === '/control/config' && method === 'PUT') {
        const patch = validateConfigPatch(await req.json());
        return json(mgr.setConfig(patch), 200, origin);
      }

      // Bunqueue 2.8.57 persists Workflow Engine executions in the same
      // dataPath. These endpoints are intentionally read-only: control methods
      // need the live Engine instance and its registered workflow definitions.
      if (pathname === '/workflows/stats' && method === 'GET') {
        return json({ ok: true, ...workflowStats(mgr.getConfig().dataPath) }, 200, origin);
      }
      if (pathname === '/workflows' && method === 'GET') {
        const sp = new URL(req.url).searchParams;
        const allowed = new Set(['kind', 'workflowName', 'state', 'limit', 'offset']);
        for (const key of sp.keys()) {
          if (!allowed.has(key)) throw new Error(`Unknown workflow option: ${key}`);
          if (sp.getAll(key).length !== 1) throw new Error(`Duplicate workflow option: ${key}`);
        }
        const kind = sp.get('kind') ?? 'active';
        if (kind !== 'active' && kind !== 'archive') {
          throw new Error('Workflow kind must be "active" or "archive"');
        }
        const state = sp.get('state') || undefined;
        if (state && state !== 'compensation' && !(WORKFLOW_STATES as readonly string[]).includes(state)) {
          throw new Error('Unknown workflow execution state');
        }
        const integer = (name: 'limit' | 'offset', fallback: number): number => {
          const raw = sp.get(name);
          if (raw === null) return fallback;
          if (!/^\d+$/.test(raw)) throw new Error(`Workflow ${name} must be an integer`);
          return Number(raw);
        };
        return json(
          {
            ok: true,
            ...workflowExecutions(mgr.getConfig().dataPath, {
              kind: kind as WorkflowStoreKind,
              workflowName: sp.get('workflowName') || undefined,
              state: state as WorkflowStateFilter | undefined,
              limit: integer('limit', 50),
              offset: integer('offset', 0),
            }),
          },
          200,
          origin
        );
      }
      if (pathname.startsWith('/workflows/') && method === 'GET') {
        const rawId = pathname.slice('/workflows/'.length);
        if (!rawId || rawId.includes('/')) return json({ ok: false, error: 'Not found' }, 404, origin);
        const sp = new URL(req.url).searchParams;
        for (const key of sp.keys()) {
          if (key !== 'kind') throw new Error(`Unknown workflow detail option: ${key}`);
          if (sp.getAll(key).length !== 1) throw new Error(`Duplicate workflow detail option: ${key}`);
        }
        const kind = sp.get('kind') ?? 'active';
        if (kind !== 'active' && kind !== 'archive') {
          throw new Error('Workflow kind must be "active" or "archive"');
        }
        const execution = workflowExecution(
          mgr.getConfig().dataPath,
          decodeURIComponent(rawId),
          kind
        );
        return execution
          ? json({ ok: true, execution }, 200, origin)
          : json({ ok: false, error: 'Workflow execution not found' }, 404, origin);
      }

      // Read-only SQLite inspector (agent/db.ts opens every connection
      // readonly, so none of these can mutate the store). The POST query
      // endpoint rides the same token gate as other mutating methods.
      if (pathname === '/db/info' && method === 'GET') {
        return json({ ok: true, ...dbInfo(mgr.getConfig().dataPath) }, 200, origin);
      }
      if (pathname === '/db/tables' && method === 'GET') {
        return json({ ok: true, tables: dbTables(mgr.getConfig().dataPath) }, 200, origin);
      }
      // Segment-based routing (the client percent-encodes the table name, so it
      // never contains a literal '/'): a single trailing segment is the rows
      // route; `<table>/schema` and `<table>/cell` are sub-resources. This is
      // unambiguous even for a table literally named "schema" or "cell".
      if (pathname.startsWith('/db/tables/') && method === 'GET') {
        const segs = pathname.slice('/db/tables/'.length).split('/');
        const table = decodeURIComponent(segs[0] ?? '');
        const sub = segs[1];
        if (segs.length === 2 && sub === 'export') {
          const sp = new URL(req.url).searchParams;
          const allowedParams = new Set(['orderBy', 'dir', 'fcol', 'fop', 'fval']);
          for (const key of sp.keys()) {
            if (!allowedParams.has(key)) throw new Error(`Unknown database export option: ${key}`);
            if (sp.getAll(key).length !== 1) {
              throw new Error(`Duplicate database export option: ${key}`);
            }
          }

          const orderByParam = sp.get('orderBy');
          if (orderByParam === '') throw new Error('Database export orderBy must not be empty');
          const dirParam = sp.get('dir');
          if (dirParam !== null && dirParam !== 'asc' && dirParam !== 'desc') {
            throw new Error('Database export dir must be "asc" or "desc"');
          }
          const fCol = sp.get('fcol');
          const fOp = sp.get('fop');
          const fVal = sp.get('fval');
          const hasAnyFilterPart = fCol !== null || fOp !== null || fVal !== null;
          let filter: DbFilter | undefined;
          if (hasAnyFilterPart) {
            if (!fCol || !fVal || (fOp !== 'contains' && fOp !== 'eq' && fOp !== 'ne')) {
              throw new Error('Database export filter requires valid fcol, fop and fval values');
            }
            filter = { column: fCol, op: fOp, value: fVal };
          }

          const exported = await exportWithTimeout(
            mgr.getConfig().dataPath,
            table,
            orderByParam ?? undefined,
            dirParam === 'desc' ? 'desc' : 'asc',
            filter,
            req.signal
          );
          return new Response(exported.content, {
            status: 200,
            headers: {
              'Content-Type': 'text/csv; charset=utf-8',
              'Content-Length': String(exported.bytes),
              // Keep Content-Length equal to the authoritative export-byte contract;
              // intermediaries must not transparently recompress this body.
              'Cache-Control': 'no-store, no-transform',
              'X-Content-Type-Options': 'nosniff',
              'X-Bunqueue-Db-Export-Version': '1',
              'X-Bunqueue-Db-Export-Table': encodeURIComponent(exported.table),
              'X-Bunqueue-Db-Export-Rows': String(exported.rowCount),
              'X-Bunqueue-Db-Export-Bytes': String(exported.bytes),
              'X-Bunqueue-Db-Export-Cap': exported.cap ?? 'none',
              'Access-Control-Expose-Headers':
                'Content-Length, X-Bunqueue-Db-Export-Version, X-Bunqueue-Db-Export-Table, X-Bunqueue-Db-Export-Rows, X-Bunqueue-Db-Export-Bytes, X-Bunqueue-Db-Export-Cap',
              ...corsHeaders(origin, allowedOrigins),
            },
          });
        }
        if (segs.length === 2 && sub === 'schema') {
          return json({ ok: true, ...dbSchema(mgr.getConfig().dataPath, table) }, 200, origin);
        }
        if (segs.length === 2 && sub === 'cell') {
          const sp = new URL(req.url).searchParams;
          // Keep rowid textual through the HTTP boundary. Number() rounded
          // values above 2^53 before SQLite ever saw the bound parameter.
          const rowid = sp.get('rowid');
          if (rowid === null) throw new Error('rowid is required');
          const column = sp.get('column') ?? '';
          return json(
            { ok: true, ...dbCell(mgr.getConfig().dataPath, table, rowid, column) },
            200,
            origin
          );
        }
        if (segs.length !== 1) return json({ ok: false, error: 'Not found' }, 404, origin);
        const sp = new URL(req.url).searchParams;
        const limit = Number(sp.get('limit')) || 50;
        const offset = Number(sp.get('offset')) || 0;
        const orderBy = sp.get('orderBy') || undefined;
        const dir = sp.get('dir') === 'desc' ? 'desc' : 'asc';
        const fCol = sp.get('fcol');
        const fOp = sp.get('fop');
        const fVal = sp.get('fval');
        const filter: DbFilter | undefined =
          fCol && fVal
            ? { column: fCol, op: fOp === 'eq' ? 'eq' : fOp === 'ne' ? 'ne' : 'contains', value: fVal }
            : undefined;
        return json(
          { ok: true, ...dbRows(mgr.getConfig().dataPath, table, limit, offset, orderBy, dir, filter) },
          200,
          origin
        );
      }
      if (pathname === '/db/query' && method === 'POST') {
        const { sql } = (await req.json()) as { sql?: string };
        return json({ ok: true, ...(await queryWithTimeout(mgr.getConfig().dataPath, sql ?? '')) }, 200, origin);
      }

      return json({ ok: false, error: 'Not found' }, 404, origin);
    } catch (e) {
      // A missing database file is an expected pre-first-start condition — 404
      // so the UI can show "no database yet" distinctly from a real read error.
      const status =
        e instanceof MissingDbError
          ? 404
          : e instanceof DbExportBusyError
            ? 429
            : e instanceof DbExportUnavailableError
              ? 503
              : 400;
      return json({ ok: false, error: (e as Error).message ?? String(e) }, status, origin);
    }
  };
}
