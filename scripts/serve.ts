#!/usr/bin/env bun
/**
 * Standalone bunqueue-dashboard executable (built with `bun build --compile`).
 *
 * One binary, three jobs:
 *   1. Serves the dashboard SPA from assets embedded at compile time.
 *   2. Proxies /api/* to the bunqueue server (BUNQUEUE_URL, default :6790) —
 *      same-origin like the dev proxy, so no CORS and SSE streams through.
 *   3. Runs the control agent (start/stop/restart bunqueue) on 127.0.0.1:6800
 *      with the same Origin-allowlist security as agent/index.ts.
 *
 * Env: PORT (dashboard, default 8080) · BUNQUEUE_URL · AGENT_PORT ·
 *      AGENT_ALLOWED_ORIGINS · AGENT_TOKEN · BUNQUEUE_START_CMD · HTTP_PORT ·
 *      TCP_PORT · BUNQUEUE_DATA_PATH
 */
import { ProcessManager } from '../agent/manager';
import { createFetchHandler, resolveAllowedOrigins } from '../agent/server';
import { ASSETS } from './embedded.gen';

const PORT = Number(process.env.PORT) || 8080;
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

// Dashboard + /api proxy.
Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

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
    const key = url.pathname === '/' ? '/index.html' : url.pathname;
    const asset =
      ASSETS[key] ?? (url.pathname.startsWith('/assets/') ? undefined : ASSETS['/index.html']);
    if (!asset) return new Response('Not found', { status: 404 });
    return new Response(Bun.file(asset));
  },
});

console.log('bunqueue dashboard (standalone)');
console.log(`  dashboard  → http://localhost:${PORT}`);
console.log(`  api proxy  → ${API}`);
console.log(`  agent      → http://127.0.0.1:${AGENT_PORT}/control`);
