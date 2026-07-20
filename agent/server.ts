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
 *     inspector (job payloads) even with a token set (the token exempts reads).
 *     When `allowedHosts` is configured, a request whose `Host` header names a
 *     hostname outside the allowlist is rejected (403) — the rebinding page's
 *     `Host` is the attacker's domain, never a loopback/allowlisted host.
 *  4. Optional bearer token (AGENT_TOKEN): when set, state-changing requests
 *     must present it (`Authorization: Bearer <t>` or `x-agent-token: <t>`).
 */
import { type DbFilter, dbCell, dbInfo, dbRows, dbSchema, dbTables, MissingDbError, queryWithTimeout } from './db';
import type { ProcessManager, ServerConfig } from './manager';

export interface AgentOptions {
  allowedOrigins: string[];
  /**
   * DNS-rebinding defense: when set (non-empty), a request whose `Host` header
   * resolves to a hostname outside this list is rejected. Compared by hostname
   * only (port stripped). Leave undefined to disable the check — e.g. when the
   * agent is fronted by a proxy that already validates Host, or bound to a
   * non-loopback interface where the user opted into network exposure.
   */
  allowedHosts?: string[];
  /** When set, POST/PUT requests must present this token. */
  token?: string;
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
  return (i === -1 ? s : s.slice(0, i)).toLowerCase();
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
 * Host-header allowlist. Disabled (always true) when `allowed` is undefined. A
 * missing Host header is a non-browser/loopback caller and is allowed; a
 * present Host must match by hostname. A DNS-rebinding page always sends its
 * own domain as Host, so it fails this check.
 */
export function isHostAllowed(host: string | null, allowed?: string[]): boolean {
  if (!allowed) return true;
  if (!host) return true; // non-browser caller — no Host header
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
  if (!token) return true;
  const auth = req.headers.get('authorization') ?? '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return bearer === token || req.headers.get('x-agent-token') === token;
}

/**
 * Build the fetch handler for the agent. Pure w.r.t. the network — takes a
 * ProcessManager and policy, returns an async (req) => Response.
 */
export function createFetchHandler(mgr: ProcessManager, opts: AgentOptions) {
  const { allowedOrigins, allowedHosts, token } = opts;

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
          const h = (await res.json()) as { ok?: boolean; version?: string };
          healthy = h.ok !== false;
          version = h.version;
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

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin, allowedOrigins) });
    }

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

    // The optional AGENT_TOKEN gates STATE-CHANGING requests only. Read-only
    // GETs (including the /db/* inspector, which can expose job payloads) are
    // protected by the Origin allowlist alone — a drive-by cross-origin page
    // can't read the response (no ACAO for its origin), which is the real
    // threat. Reads intentionally remain available without a token for local
    // dashboards that don't configure AGENT_TOKEN; when a token is configured,
    // the browser client does send it, but only POST/PUT require it.
    // Non-browser local callers on loopback are trusted for reads.
    const mutating = method === 'POST' || method === 'PUT';
    if (mutating && !tokenOk(req, token)) {
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
        const patch = (await req.json()) as Partial<ServerConfig>;
        return json(mgr.setConfig(patch), 200, origin);
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
        if (segs.length === 2 && sub === 'schema') {
          return json({ ok: true, ...dbSchema(mgr.getConfig().dataPath, table) }, 200, origin);
        }
        if (segs.length === 2 && sub === 'cell') {
          const sp = new URL(req.url).searchParams;
          const rowid = Number(sp.get('rowid'));
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
      const status = e instanceof MissingDbError ? 404 : 400;
      return json({ ok: false, error: (e as Error).message ?? String(e) }, status, origin);
    }
  };
}
