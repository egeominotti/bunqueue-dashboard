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
 *   - Truly local loopback access (the default): /agent/* keeps zero-config
 *     reads, and the direct loopback :6800 listener remains local-only.
 *   - Non-loopback bind (BIND_ADDR=0.0.0.0): AGENT_TOKEN is mandatory and gates
 *     EVERY agent route, including status/log/database reads. The public
 *     listener also keeps a Host allowlist; put every public/LAN hostname or IP
 *     in AGENT_ALLOWED_HOSTS (or AGENT_ALLOWED_ORIGINS) to admit it. There is no
 *     unauthenticated remote-control opt-in.
 *   - A loopback bind reached through a reverse proxy follows the same remote
 *     rule. TRUST_PROXY, non-loopback allowlists/origins, forwarding headers or
 *     a non-loopback request Host all switch the bridge to all-route token auth.
 *   - The same signals gate the administrative /api proxy independently with
 *     BUNQUEUE_TOKEN; without it, remote/proxied /api access is disabled.
 *
 * Env: PORT (dashboard, default 8080) · BIND_ADDR (default 127.0.0.1) ·
 *      BUNQUEUE_URL · AGENT_PORT · AGENT_ALLOWED_ORIGINS · AGENT_ALLOWED_HOSTS ·
 *      AGENT_TOKEN · BUNQUEUE_TOKEN · TRUST_PROXY · BUNQUEUE_START_CMD ·
 *      HTTP_PORT · TCP_PORT · BUNQUEUE_DATA_PATH · LOG_LEVEL (pino level, info)
 */
import { timingSafeEqual } from 'node:crypto';
import { logger } from '../agent/logger';
import { setQueryWorkerUrl } from '../agent/db';
import {
  createFetchHandler,
  hostnameOf,
  isHostAllowed,
  isOriginAllowed,
  resolveAllowedHosts,
  resolveAllowedOrigins,
} from '../agent/server';

export const RESPONSE_SECURITY_HEADERS = {
  'Content-Security-Policy': "frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
} as const;

export function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(RESPONSE_SECURITY_HEADERS)) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** True loopback names/addresses. 0.0.0.0 is a wildcard, never local-only. */
export function isLoopbackHost(host: string): boolean {
  const value = hostnameOf(host);
  const octets = value.split('.');
  const ipv4Loopback =
    octets.length === 4 &&
    octets[0] === '127' &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
  return (
    value === 'localhost' ||
    value === '::1' ||
    value === '0:0:0:0:0:0:0:1' ||
    ipv4Loopback
  );
}

/** Bind addresses that mean "only this machine can reach the listener". */
export function isLoopbackBind(host: string): boolean {
  return isLoopbackHost(host);
}

function configuredValues(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * A loopback socket can still be public through a reverse proxy. These are
 * operator-controlled signals that the same-origin /agent bridge is intended
 * to be reachable beyond the machine, so its reads and writes must both use
 * the bearer-token policy.
 */
export function remoteBridgeRequiresToken(
  loopbackBind: boolean,
  env: Record<string, string | undefined> = process.env
): boolean {
  if (!loopbackBind || env.TRUST_PROXY === '1') return true;
  const configured = [
    ...configuredValues(env.AGENT_ALLOWED_HOSTS),
    ...configuredValues(env.AGENT_ALLOWED_ORIGINS),
  ];
  return configured.some((value) => !isLoopbackHost(value));
}

const PROXY_HINT_HEADERS = [
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
] as const;

/**
 * Per-request backstop for a public Host/Origin or a proxy that adds forwarding
 * metadata. Forwarded-header presence is only used to demand stronger auth;
 * values remain untrusted unless TRUST_PROXY enables the Origin comparison.
 */
export function isRemoteBridgeRequest(req: Request, remotePolicy = false): boolean {
  if (remotePolicy || PROXY_HINT_HEADERS.some((name) => req.headers.has(name))) return true;
  const origin = req.headers.get('origin');
  if (origin && !isLoopbackHost(origin)) return true;
  const host = req.headers.get('host') ?? new URL(req.url).hostname;
  return !isLoopbackHost(host);
}

/** Exact, timing-safe bearer comparison for the standalone admin-API proxy. */
export function apiTokenOk(req: Request, token: string | undefined): boolean {
  if (!token) return false;
  const authorization = req.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(authorization.slice('Bearer '.length));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

/** Host policy shared by main() and deployment regression tests. */
export function resolveServeAllowedHosts(
  bindHost: string,
  allowedOrigins: string[],
  env: Record<string, string | undefined> = process.env
): string[] {
  const originHosts = allowedOrigins
    .map((origin) => {
      try {
        return new URL(origin).hostname;
      } catch {
        return '';
      }
    })
    .filter(Boolean);
  const concreteBindHosts = bindHost === '0.0.0.0' || bindHost === '::' ? [] : [bindHost];
  return resolveAllowedHosts(env, [...originHosts, ...concreteBindHosts]);
}

/**
 * May the process-spawning bridge be enabled? Truly local access stays
 * zero-config; any remote deployment policy requires a real token. This
 * intentionally ignores the former unauthenticated escape hatch.
 */
export function remoteControlEnabled(
  remotePolicy: boolean,
  env: Record<string, string | undefined> = process.env
): boolean {
  if (!remotePolicy) return true;
  return Boolean(env.AGENT_TOKEN?.trim());
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
  /** Local policy: zero-config reads, configured token on mutations. */
  agentHandle: (req: Request) => Response | Promise<Response>;
  /** Remote/proxied policy: configured token on every agent route. */
  remoteAgentHandle: (req: Request) => Response | Promise<Response>;
  allowedOrigins: string[];
  allowedHosts?: string[];
  /** false → /agent/* is refused under a remote policy without AGENT_TOKEN. */
  agentBridge: boolean;
  /** Whether the remote bridge has a non-empty AGENT_TOKEN to enforce. */
  agentTokenConfigured: boolean;
  /**
   * Bearer required by /api on every remote/proxied request. It is deliberately
   * independent of AGENT_TOKEN because the two credentials protect different
   * principals and can be rotated independently.
   */
  apiToken?: string;
  /** Deployment-level signal that even a loopback bind is externally proxied. */
  remoteBridgePolicy?: boolean;
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
    remoteAgentHandle,
    allowedOrigins,
    allowedHosts,
    agentBridge,
    agentTokenConfigured,
    apiToken,
    remoteBridgePolicy = false,
    trustProxy = false,
  } = opts;
  const secure = withSecurityHeaders;
  const indexResponse = () =>
    new Response(indexHtml, { headers: { 'content-type': 'text/html; charset=utf-8' } });

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // DNS-rebinding defense across every route (/api proxy, /agent, assets):
    // a rebound page sends its own domain as Host. Main configures this on both
    // loopback and network binds; tests/custom embedders may omit the policy.
    if (!isHostAllowed(req.headers.get('host'), allowedHosts)) {
      return secure(new Response('Host not allowed', { status: 403 }));
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
    // The selected agent handler still applies Host, Origin and token policy;
    // this bridge changes reachability, never authorization.
    if (url.pathname === '/agent' || url.pathname.startsWith('/agent/')) {
      const remoteRequest = isRemoteBridgeRequest(req, remoteBridgePolicy);
      if (!agentBridge || (remoteRequest && !agentTokenConfigured)) {
        return secure(
          Response.json(
            {
              ok: false,
              error:
                'Control agent disabled for remote or proxied access. Set AGENT_TOKEN to expose it.',
            },
            { status: 403 }
          )
        );
      }
      const sub = agentSubUrl(url.pathname, url.search);
      const headers = new Headers(req.headers);
      // Drop a same-origin Origin the agent's static allowlist cannot know
      // (a LAN IP / hostname alias). Loopback origins are already allowlisted,
      // so they are forwarded untouched and CORS behaviour is unchanged.
      if (sameOrigin && origin && !isOriginAllowed(origin, allowedOrigins)) headers.delete('origin');
      const handleAgent = remoteRequest ? remoteAgentHandle : agentHandle;
      return secure(
        await handleAgent(
          new Request(sub.href, {
            method: req.method,
            headers,
            body: req.body,
            signal: req.signal,
          })
        )
      );
    }

    // Same-origin proxy to the bunqueue server (mirrors the Vite dev proxy).
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      // The proxy talks to bunqueue's admin API, so it needs the same drive-by
      // CSRF gate as the agent: a cross-site page must not reach it.
      if (!sameOrigin && !isOriginAllowed(origin, allowedOrigins)) {
        return secure(
          Response.json({ ok: false, error: 'Origin not allowed' }, { status: 403 })
        );
      }
      // Host/Origin checks stop browser CSRF and DNS rebinding; they do not
      // authenticate curl, LAN peers or callers whose upstream has AUTH_TOKENS
      // disabled. Fail closed for every public/proxied request at this boundary.
      if (isRemoteBridgeRequest(req, remoteBridgePolicy)) {
        if (!apiToken) {
          return secure(
            Response.json(
              {
                ok: false,
                error:
                  'Admin API proxy disabled for remote or proxied access. Set BUNQUEUE_TOKEN to expose it.',
              },
              { status: 403 }
            )
          );
        }
        if (!apiTokenOk(req, apiToken)) {
          return secure(
            Response.json(
              { ok: false, error: 'A valid BUNQUEUE_TOKEN bearer token is required.' },
              { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } }
            )
          );
        }
      }
      const target = api + (url.pathname.slice(4) || '/') + url.search;
      let res: Response;
      try {
        res = await fetch(target, {
          method: req.method,
          headers: req.headers,
          body: req.body,
          redirect: 'manual',
          signal: req.signal,
        });
      } catch (err) {
        // bunqueue not running / wrong BUNQUEUE_URL: answer in the shape the
        // dashboard parses instead of letting Bun render an HTML error page.
        return secure(
          Response.json(
            { ok: false, error: `bunqueue unreachable at ${api}: ${(err as Error).message}` },
            { status: 502 }
          )
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
      return secure(
        new Response(res.body, { status: res.status, statusText: res.statusText, headers })
      );
    }

    // Embedded static assets with SPA history fallback. A missing fingerprinted
    // /assets/* file must 404 (as docker/Caddyfile does) — falling back to
    // index.html would feed HTML to a stale chunk import() and mask the miss.
    // index.html (direct or via fallback) is served from the injected copy.
    const key = url.pathname === '/' ? '/index.html' : url.pathname;
    if (key === '/index.html') return secure(indexResponse());
    const asset = assets[key];
    if (asset) return secure(new Response(Bun.file(asset)));
    if (url.pathname.startsWith('/assets/')) {
      return secure(new Response('Not found', { status: 404 }));
    }
    return secure(indexResponse());
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

  // DNS-rebinding defense (see agent/server.ts). Enforced on the loopback :6800
  // listener AND on the dashboard listener for every bind. For a concrete bind
  // address, admit that address automatically. A wildcard bind cannot reveal
  // which LAN/public address clients use, so the operator must list those names
  // or IPs in AGENT_ALLOWED_HOSTS (origins in AGENT_ALLOWED_ORIGINS also count).
  const loopbackBind = isLoopbackBind(HOST);
  const remoteBridgePolicy = remoteBridgeRequiresToken(loopbackBind, process.env);
  const allowedHosts = resolveServeAllowedHosts(HOST, allowedOrigins, process.env);

  // Imported here rather than at module scope: this file's exported policy
  // helpers are unit-tested, and a top-level import would pull the whole
  // ProcessManager into every test that touches them — which, besides being
  // wasteful, makes Bun attribute a barely-executed copy of agent/manager.ts to
  // the coverage report and hides that module's real coverage.
  const { ProcessManager } = await import('../agent/manager');
  const mgr = new ProcessManager();
  const token = process.env.AGENT_TOKEN?.trim() || undefined;
  const apiToken = process.env.BUNQUEUE_TOKEN?.trim() || undefined;
  // Two handlers, same manager: the loopback :6800 listener keeps the Host gate
  // unconditionally (it is always reached as localhost/127.0.0.1), while the
  // bridged one sees the dashboard client's Host and follows `allowedHosts`.
  const localAgentHandle = createFetchHandler(mgr, {
    allowedOrigins,
    allowedHosts,
    token,
  });
  const remoteAgentHandle = createFetchHandler(mgr, {
    allowedOrigins,
    allowedHosts,
    token,
    requireTokenForAll: true,
  });
  // `error` is a backstop: without it an unexpected throw renders Bun's HTML
  // error page (with a stack trace) to the client instead of a plain 500.
  const onError = () => withSecurityHeaders(new Response('Internal error', { status: 500 }));
  Bun.serve({
    port: AGENT_PORT,
    hostname: '127.0.0.1',
    fetch: localAgentHandle,
    error: onError,
  });

  const agentBridge = remoteControlEnabled(remoteBridgePolicy, process.env);
  if (!agentBridge) {
    logger.warn(
      { bind: HOST, remoteBridgePolicy },
      'remote or proxied bridge policy without AGENT_TOKEN — /agent is disabled (403)'
    );
  }
  if (remoteBridgePolicy && !apiToken) {
    logger.warn(
      { apiProxy: API },
      'remote or proxied bridge policy without BUNQUEUE_TOKEN — /api is disabled (403)'
    );
  } else if (remoteBridgePolicy) {
    logger.info(
      { apiProxy: API },
      'remote or proxied /api requires the configured BUNQUEUE_TOKEN bearer'
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
      agentHandle: localAgentHandle,
      remoteAgentHandle,
      allowedOrigins,
      allowedHosts,
      agentBridge,
      agentTokenConfigured: Boolean(token),
      apiToken,
      remoteBridgePolicy,
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
      remoteBridgePolicy,
      allowedHosts,
    },
    'bunqueue dashboard (standalone) ready'
  );
}

if (import.meta.main) await main();
