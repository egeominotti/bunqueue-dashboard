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
 * Env: PORT (dashboard, default 8080) · BIND_ADDR (default 127.0.0.1) ·
 *      BUNQUEUE_URL · AGENT_PORT · AGENT_ALLOWED_ORIGINS · AGENT_TOKEN ·
 *      BUNQUEUE_START_CMD · HTTP_PORT · TCP_PORT · BUNQUEUE_DATA_PATH ·
 *      LOG_LEVEL (pino level, default info)
 */
import { logger } from '../agent/logger';
import { ProcessManager } from '../agent/manager';
import { createFetchHandler, resolveAllowedOrigins } from '../agent/server';
import { ASSETS } from './embedded.gen';

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
const mgr = new ProcessManager();
const agentHandle = createFetchHandler(mgr, {
  allowedOrigins,
  token: process.env.AGENT_TOKEN || undefined,
});
Bun.serve({ port: AGENT_PORT, hostname: '127.0.0.1', fetch: agentHandle });

// index.html with the runtime agent base injected, prepared once at startup.
// The SPA's lib/bq.ts reads window.__BUNQUEUE_AGENT_URL__ before its baked-in
// default, so Server Control works whatever AGENT_PORT is — the /agent/*
// route below forwards to the in-process agent handler.
const INDEX_HTML = (await Bun.file(ASSETS['/index.html']).text()).replace(
  '</head>',
  "<script>window.__BUNQUEUE_AGENT_URL__='/agent'</script></head>"
);
const indexResponse = () =>
  new Response(INDEX_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });

// Dashboard + /api proxy + same-origin /agent proxy.
Bun.serve({
  port: PORT,
  hostname: HOST,
  async fetch(req) {
    const url = new URL(req.url);

    // Same-origin bridge to the control agent: strip the /agent prefix and
    // hand the request to the in-process agent handler (no loopback hop).
    // The agent's own Origin allowlist + optional AGENT_TOKEN still apply —
    // this changes reachability, not authorization.
    if (url.pathname === '/agent' || url.pathname.startsWith('/agent/')) {
      const sub = new URL(url.pathname.slice('/agent'.length) || '/', 'http://agent.internal');
      sub.search = url.search;
      return agentHandle(new Request(sub, req));
    }

    // Same-origin proxy to the bunqueue server (mirrors the Vite dev proxy).
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      const target = API + (url.pathname.slice(4) || '/') + url.search;
      const res = await fetch(target, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        redirect: 'manual',
      });
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
    const asset = ASSETS[key];
    if (asset) return new Response(Bun.file(asset));
    if (url.pathname.startsWith('/assets/')) return new Response('Not found', { status: 404 });
    return indexResponse();
  },
});

logger.info(
  {
    dashboard: `http://${HOST}:${PORT}`,
    apiProxy: API,
    agent: `http://127.0.0.1:${AGENT_PORT}/control`,
  },
  'bunqueue dashboard (standalone) ready'
);
