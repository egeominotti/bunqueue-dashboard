/**
 * bunqueue dashboard control agent.
 *
 * A tiny local Bun server that lets the dashboard start / stop / restart a
 * bunqueue server process. It can spawn processes, so it binds 127.0.0.1 only
 * AND enforces an Origin allowlist + locked CORS (never `*`) so a malicious web
 * page cannot drive it via CSRF (see server.ts for the full threat model). Set
 * AGENT_TOKEN for an extra bearer-token gate on state-changing requests.
 *
 * Run:  bun run agent/index.ts        (default port 6800)
 * Env:  AGENT_PORT, AGENT_ALLOWED_ORIGINS, AGENT_TOKEN,
 *       BUNQUEUE_START_CMD, HTTP_PORT, TCP_PORT, BUNQUEUE_DATA_PATH
 */
import { logger } from './logger';
import { ProcessManager } from './manager';
import { createFetchHandler, resolveAllowedHosts, resolveAllowedOrigins } from './server';

const mgr = new ProcessManager();
const PORT = Number(process.env.AGENT_PORT) || 6800;
const allowedOrigins = resolveAllowedOrigins();
// The agent binds loopback only, so a legitimate Host is always a loopback
// hostname (localhost / 127.0.0.1). Enforcing the allowlist blocks a page whose
// DNS was rebound to 127.0.0.1 from reading /control or /db over same-origin
// GETs. Extend via AGENT_ALLOWED_HOSTS when fronted by a proxy on another host.
const allowedHosts = resolveAllowedHosts();
const token = process.env.AGENT_TOKEN || undefined;

const handle = createFetchHandler(mgr, { allowedOrigins, allowedHosts, token });

Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  fetch: handle,
});

// Stop the managed server before exiting — without this, Ctrl-C / SIGTERM on
// the agent orphans the spawned bunqueue child (it reparents to PID 1 and keeps
// holding the ports and the SQLite db, so the next start fails EADDRINUSE).
let shuttingDown = false;
const shutdown = (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'signal received, stopping managed server');
  // shutdown() (not stop()) latches the manager closed first: a plain stop()
  // racing an in-flight restart() returns successfully *because* restart's
  // start() already spawned a replacement — which process.exit() would orphan.
  void mgr.shutdown().finally(() => process.exit(0));
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

logger.info(
  { url: `http://127.0.0.1:${PORT}/control`, allowedOrigins, allowedHosts, tokenAuth: Boolean(token) },
  'bunqueue dashboard control agent ready'
);
