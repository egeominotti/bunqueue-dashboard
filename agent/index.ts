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
import { createFetchHandler, resolveAllowedOrigins } from './server';

const mgr = new ProcessManager();
const PORT = Number(process.env.AGENT_PORT) || 6800;
const allowedOrigins = resolveAllowedOrigins();
const token = process.env.AGENT_TOKEN || undefined;

const handle = createFetchHandler(mgr, { allowedOrigins, token });

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
  void mgr.stop().finally(() => process.exit(0));
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

logger.info(
  { url: `http://127.0.0.1:${PORT}/control`, allowedOrigins, tokenAuth: Boolean(token) },
  'bunqueue dashboard control agent ready'
);
