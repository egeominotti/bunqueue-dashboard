#!/usr/bin/env bun
/**
 * Standalone bunqueue-dashboard executable (built with `bun build --compile`).
 *
 * One binary, three jobs:
 *   1. Serves the dashboard SPA from assets embedded at compile time.
 *   2. Proxies /api/* to the bunqueue server (BUNQUEUE_URL, default :6790) —
 *      same-origin like the dev proxy, so no CORS and SSE streams through.
 *   3. Runs the control agent (start/stop/restart bunqueue) on 127.0.0.1:6800
 *      with the same Origin-allowlist security as agent/index.ts — and ALSO
 *      exposes it same-origin at /agent/* (the served index.html gets
 *      `window.__BUNQUEUE_AGENT_URL__ = '/agent'` injected), so the prebuilt
 *      SPA finds the agent regardless of AGENT_PORT and even from a remote
 *      browser, where loopback :6800 would be unreachable.
 *
 * Control-plane exposure rule (the agent can spawn processes):
 *   - Loopback bind (the default): /agent/* is bridged, and the loopback :6800
 *     listener keeps its Host allowlist (DNS-rebinding defense).
 *   - Non-loopback bind (BIND_ADDR=0.0.0.0): the bridge would hand the whole
 *     LAN an unauthenticated process spawner (the agent's Origin gate lets an
 *     Origin-less curl through by design), so it is REFUSED with 403 unless the
 *     operator opts in with AGENT_TOKEN (recommended — it gates every mutation)
 *     or AGENT_ALLOW_REMOTE_CONTROL=1 (explicit, unauthenticated).
 *
 * Env: PORT (dashboard, default 8080) · BIND_ADDR (default 127.0.0.1) ·
 *      BUNQUEUE_URL · AGENT_PORT · AGENT_ALLOWED_ORIGINS · AGENT_ALLOWED_HOSTS ·
 *      AGENT_TOKEN · AGENT_ALLOW_REMOTE_CONTROL · TRUST_PROXY · BUNQUEUE_START_CMD ·
 *      HTTP_PORT · TCP_PORT · BUNQUEUE_DATA_PATH · LOG_LEVEL (pino level, info)
 */
import { logger } from '../agent/logger';
import { setQueryWorkerUrl } from '../agent/db';
import {
  createFetchHandler,
  isHostAllowed,
  isOriginAllowed,
  resolveAllowedHosts,
  resolveAllowedOrigins,
} from '../agent/server';

/** Hostnames that mean "only this machine can reach the listener". */
export function isLoopbackBind(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

/**
 * May the process-spawning control plane be reachable over the network?
 * Loopback always yes; a non-loopback bind requires an explicit opt-in.
 */
export function remoteControlEnabled(
  loopbackBind: boolean,
  env: Record<string, string | undefined> = process.env
): boolean {
  if (loopbackBind) return true;
  return Boolean(env.AGENT_TOKEN) || env.AGENT_ALLOW_REMOTE_CONTROL === '1';
}

/**
 * Build the inner agent URL from the bridged path. `new URL(rest, base)` throws
 * on a path like `//x:y/z` (it reads `//` as an authority); assigning .pathname
 * never reinterprets it, so a hostile path can't crash the handler.
 */
export function agentSubUrl(pathname: string, search: string): URL {
  const rest = pathname.slice('/agent'.length) || '/';
  const sub = new URL('http://agent.internal');
  sub.pathname = rest.startsWith('/') ? rest : `/${rest}`;
  sub.search = search;
  return sub;
}

export interface ServeHandlerOptions {
  /** bunqueue base URL the /api prefix proxies to (no trailing slash). */
  api: string;
  /** index.html with the agent base already injected. */
  indexHtml: string;
  /** embedded dist assets: request path → on-disk path. */
  assets: Record<string, string>;
  /** in-process control agent handler. */
  agentHandle: (req: Request) => Response | Promise<Response>;
  allowedOrigins: string[];
  allowedHosts?: string[];
  /** false → /agent/* is refused (non-loopback bind without opt-in). */
  agentBridge: boolean;
  /**
   * TRUST_PROXY=1 — a reverse proxy in front of us owns X-Forwarded-Host, so it
   * may be believed. Off by default: the header is otherwise client-settable
   * and would let any direct caller declare itself same-origin.
   */
  trustProxy?: boolean;
}

/**
 * The dashboard listener: static assets + /api proxy + same-origin /agent
 * bridge. Factored out of the Bun.serve call so the policy is unit-testable.
 */
export function createServeHandler(opts: ServeHandlerOptions) {
  const {
    api,
    indexHtml,
    assets,
    agentHandle,
    allowedOrigins,
    allowedHosts,
    agentBridge,
    trustProxy = false,
  } = opts;
  const indexResponse = () =>
    new Response(indexHtml, { headers: { 'content-type': 'text/html; charset=utf-8' } });

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // DNS-rebinding defense across every route (/api proxy, /agent, assets):
    // a page rebound to this loopback port sends its own domain as Host. No-op
    // on non-loopback binds (allowedHosts is undefined there).
    if (!isHostAllowed(req.headers.get('host'), allowedHosts)) {
      return new Response('Host not allowed', { status: 403 });
    }

    // A request whose Origin is the origin this listener serves from is by
    // definition not the cross-site case the allowlist exists for. It is what a
    // LAN browser sends (http://<lan-ip>:PORT), which no static allowlist can
    // predict — treat it as allowed everywhere below.
    //
    // Compared by HOST, not by full origin: this listener only ever speaks
    // plain http, so behind a TLS-terminating reverse proxy the browser sends
    // `https://dash.example.com` while req.url reads `http://dash.example.com`.
    // A full-origin compare would 403 every mutation on a proxied deployment
    // while read-only GETs (which carry no Origin) kept working — a dashboard
    // that looks healthy and fails on click. The host is the part that
    // identifies a cross-site page (its Origin carries its OWN host), so it is
    // the part worth comparing. x-forwarded-host is honoured for proxies that
    // rewrite Host.
    const origin = req.headers.get('origin');
    let originHost = '';
    try {
      originHost = origin ? new URL(origin).host.toLowerCase() : '';
    } catch {
      originHost = ''; // unparseable Origin — treat as cross-site
    }
    // X-Forwarded-Host is attacker-controlled unless something in front of us
    // is guaranteed to overwrite it: a direct caller can send
    // `Origin: https://evil.example` + `x-forwarded-host: evil.example` and
    // declare ITSELF same-origin. So it is consulted only when the operator
    // sets TRUST_PROXY=1, which asserts a reverse proxy owns that header.
    // Without it, a proxy that preserves Host still works (the Host compare
    // below covers it); only a Host-REWRITING proxy needs the opt-in.
    const fwd = trustProxy ? req.headers.get('x-forwarded-host')?.split(',') : undefined;
    const forwardedHost = fwd?.[fwd.length - 1]?.trim().toLowerCase();
    const sameOrigin =
      originHost !== '' &&
      (originHost === url.host.toLowerCase() || originHost === forwardedHost);

    // Same-origin bridge to the control agent: strip the /agent prefix and
    // hand the request to the in-process agent handler (no loopback hop).
    // The agent's own Origin allowlist + optional AGENT_TOKEN still apply —
    // this changes reachability, not authorization.
    if (url.pathname === '/agent' || url.pathname.startsWith('/agent/')) {
      if (!agentBridge) {
        return Response.json(
          {
            ok: false,
            error:
              'Control agent disabled on a non-loopback bind. Set AGENT_TOKEN (recommended) or AGENT_ALLOW_REMOTE_CONTROL=1 to expose it.',
          },
          { status: 403 }
        );
      }
      const sub = agentSubUrl(url.pathname, url.search);
      const headers = new Headers(req.headers);
      // Drop a same-origin Origin the agent's static allowlist cannot know
      // (a LAN IP / hostname alias). Loopback origins are already allowlisted,
      // so they are forwarded untouched and CORS behaviour is unchanged.
      if (sameOrigin && origin && !isOriginAllowed(origin, allowedOrigins)) headers.delete('origin');
      return agentHandle(new Request(sub.href, { method: req.method, headers, body: req.body }));
    }

    // Same-origin proxy to the bunqueue server (mirrors the Vite dev proxy).
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      // The proxy talks to bunqueue's admin API, so it needs the same drive-by
      // CSRF gate as the agent: a cross-site page must not reach it.
      if (!sameOrigin && !isOriginAllowed(origin, allowedOrigins)) {
        return Response.json({ ok: false, error: 'Origin not allowed' }, { status: 403 });
      }
      const target = api + (url.pathname.slice(4) || '/') + url.search;
      let res: Response;
      try {
        res = await fetch(target, {
          method: req.method,
          headers: req.headers,
          body: req.body,
          redirect: 'manual',
        });
      } catch (err) {
        // bunqueue not running / wrong BUNQUEUE_URL: answer in the shape the
        // dashboard parses instead of letting Bun render an HTML error page.
        return Response.json(
          { ok: false, error: `bunqueue unreachable at ${api}: ${(err as Error).message}` },
          { status: 502 }
        );
      }
      // Bun's fetch advertises accept-encoding upstream and transparently
      // DECOMPRESSES the body, but leaves the upstream headers intact. If the
      // bunqueue server sits behind any gzip-compressing proxy, forwarding
      // those headers labels plaintext as gzip and the browser fails to decode
      // every /api response (ERR_CONTENT_DECODING_FAILED) — strip them.
      const headers = new Headers(res.headers);
      headers.delete('content-encoding');
      headers.delete('content-length');
      headers.delete('transfer-encoding');
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    }

    // Embedded static assets with SPA history fallback. A missing fingerprinted
    // /assets/* file must 404 (as docker/Caddyfile does) — falling back to
    // index.html would feed HTML to a stale chunk import() and mask the miss.
    // index.html (direct or via fallback) is served from the injected copy.
    const key = url.pathname === '/' ? '/index.html' : url.pathname;
    if (key === '/index.html') return indexResponse();
    const asset = assets[key];
    if (asset) return new Response(Bun.file(asset));
    if (url.pathname.startsWith('/assets/')) return new Response('Not found', { status: 404 });
    return indexResponse();
  };
}

async function main(): Promise<void> {
  // Bun emits secondary TypeScript entrypoints under /$bunfs/root as JavaScript.
  // Point db.ts at that embedded path in a compiled executable; when this npm bin
  // runs from source, use the real TypeScript module beside agent/db.ts.
  const compiled = import.meta.url.includes('/$bunfs/');
  setQueryWorkerUrl(
    compiled
      ? new URL('/$bunfs/root/agent/dbQueryWorker.js', 'file:///').href
      : new URL('../agent/dbQueryWorker.ts', import.meta.url).href
  );

  const PORT = Number(process.env.PORT) || 8080;
  // Bind loopback by default: the /api proxy forwards to bunqueue's admin API, so
  // listening on all interfaces would expose it to the whole network. Set
  // BIND_ADDR=0.0.0.0 for direct LAN access (e.g. no reverse proxy in front).
  const HOST = process.env.BIND_ADDR || '127.0.0.1';
  const API = (process.env.BUNQUEUE_URL || 'http://localhost:6790').replace(/\/$/, '');
  const AGENT_PORT = Number(process.env.AGENT_PORT) || 6800;

  // Control agent — loopback only, allowlisted CORS; the origins this binary
  // serves the dashboard from are allowed automatically.
  const allowedOrigins = Array.from(
    new Set([
      ...resolveAllowedOrigins(),
      `http://localhost:${PORT}`,
      `http://127.0.0.1:${PORT}`,
    ])
  );

  // DNS-rebinding defense (see agent/server.ts). Always enforced on the loopback
  // :6800 listener. On the public dashboard listener it is only enforced for a
  // loopback bind — when the user binds a non-loopback interface
  // (BIND_ADDR=0.0.0.0) a fixed host allowlist would break legitimate LAN-IP
  // access, and the control plane there is gated by remoteControlEnabled()
  // instead (AGENT_TOKEN / AGENT_ALLOW_REMOTE_CONTROL).
  const loopbackBind = isLoopbackBind(HOST);
  const originHosts = allowedOrigins
    .map((o) => {
      try {
        return new URL(o).hostname;
      } catch {
        return '';
      }
    })
    .filter(Boolean);
  const agentHosts = resolveAllowedHosts(process.env, originHosts);
  const allowedHosts = loopbackBind ? agentHosts : undefined;

  // Imported here rather than at module scope: this file's exported policy
  // helpers are unit-tested, and a top-level import would pull the whole
  // ProcessManager into every test that touches them — which, besides being
  // wasteful, makes Bun attribute a barely-executed copy of agent/manager.ts to
  // the coverage report and hides that module's real coverage.
  const { ProcessManager } = await import('../agent/manager');
  const mgr = new ProcessManager();
  const token = process.env.AGENT_TOKEN || undefined;
  // Two handlers, same manager: the loopback :6800 listener keeps the Host gate
  // unconditionally (it is always reached as localhost/127.0.0.1), while the
  // bridged one sees the dashboard client's Host and follows `allowedHosts`.
  const agentHandle = createFetchHandler(mgr, { allowedOrigins, allowedHosts, token });
  const loopbackAgentHandle = createFetchHandler(mgr, {
    allowedOrigins,
    allowedHosts: agentHosts,
    token,
  });
  // `error` is a backstop: without it an unexpected throw renders Bun's HTML
  // error page (with a stack trace) to the client instead of a plain 500.
  const onError = () => new Response('Internal error', { status: 500 });
  Bun.serve({
    port: AGENT_PORT,
    hostname: '127.0.0.1',
    fetch: loopbackAgentHandle,
    error: onError,
  });

  const agentBridge = remoteControlEnabled(loopbackBind, process.env);
  if (!agentBridge) {
    logger.warn(
      { bind: HOST },
      'non-loopback bind without AGENT_TOKEN / AGENT_ALLOW_REMOTE_CONTROL=1 — /agent is disabled (403)'
    );
  }

  // index.html with the runtime agent base injected, prepared once at startup.
  // The SPA's lib/bq.ts reads window.__BUNQUEUE_AGENT_URL__ before its baked-in
  // default, so Server Control works whatever AGENT_PORT is — the /agent/*
  // route below forwards to the in-process agent handler.
  const { ASSETS } = await import('./embedded.gen');
  const indexHtml = (await Bun.file(ASSETS['/index.html']).text()).replace(
    '</head>',
    "<script>window.__BUNQUEUE_AGENT_URL__='/agent'</script></head>"
  );

  // Dashboard + /api proxy + same-origin /agent proxy.
  Bun.serve({
    port: PORT,
    hostname: HOST,
    fetch: createServeHandler({
      api: API,
      indexHtml,
      assets: ASSETS,
      agentHandle,
      allowedOrigins,
      allowedHosts,
      agentBridge,
      trustProxy: process.env.TRUST_PROXY === '1',
    }),
    error: onError,
  });

  // Stop the managed server before exiting — without this, Ctrl-C / SIGTERM on
  // the binary orphans the spawned bunqueue child (it reparents to PID 1 and
  // keeps holding the ports and the SQLite db, so the next start fails).
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'signal received, stopping managed server');
    // shutdown(), not stop(): it latches, so a restart() already in flight
    // can't spawn a fresh child after we've stopped the old one (mirrors
    // agent/index.ts).
    void mgr.shutdown().finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  logger.info(
    {
      dashboard: `http://${HOST}:${PORT}`,
      apiProxy: API,
      agent: `http://127.0.0.1:${AGENT_PORT}/control`,
      agentBridge,
    },
    'bunqueue dashboard (standalone) ready'
  );
}

if (import.meta.main) await main();
