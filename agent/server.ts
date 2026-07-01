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
 *  3. Optional bearer token (AGENT_TOKEN): when set, state-changing requests
 *     must present it (`Authorization: Bearer <t>` or `x-agent-token: <t>`).
 */
import type { ProcessManager, ServerConfig } from './manager';

export interface AgentOptions {
  allowedOrigins: string[];
  /** When set, POST/PUT requests must present this token. */
  token?: string;
}

const DEFAULT_ORIGINS = ['http://localhost:5273', 'http://127.0.0.1:5273'];

/** Parse AGENT_ALLOWED_ORIGINS (comma-separated) merged with sane dev defaults. */
export function resolveAllowedOrigins(env = process.env): string[] {
  const extra = (env.AGENT_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
  return Array.from(new Set([...DEFAULT_ORIGINS, ...extra]));
}

export function isOriginAllowed(origin: string | null, allowed: string[]): boolean {
  if (!origin) return true; // non-browser caller (curl / same process) — no Origin header
  return allowed.includes(origin.replace(/\/$/, ''));
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
  const { allowedOrigins, token } = opts;

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

    // Block any request from a disallowed browser origin before it can act.
    if (!isOriginAllowed(origin, allowedOrigins)) {
      return json({ ok: false, error: 'Origin not allowed' }, 403, origin);
    }

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

      return json({ ok: false, error: 'Not found' }, 404, origin);
    } catch (e) {
      return json({ ok: false, error: (e as Error).message ?? String(e) }, 400, origin);
    }
  };
}
