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
 *       BUNQUEUE_START_CMD, BUNQUEUE_MANAGED, BUNQUEUE_URL, BUNQUEUE_TOKEN,
 *       HTTP_PORT, TCP_PORT, BUNQUEUE_DATA_PATH
 */
import { assertRequiredBunVersion } from '../scripts/bunVersion';
import { logger } from './logger';
import { ProcessManager } from './manager';
import { agentConfigStore } from './manager/configStore';
import {
  createFetchHandler,
  resolveAllowedHosts,
  resolveAllowedOrigins,
  resolveServerControlTarget,
} from './server';
import { installAgentShutdown } from './shutdown';

assertRequiredBunVersion();

const mgr = new ProcessManager(undefined, agentConfigStore());
const PORT = Number(process.env.AGENT_PORT) || 6800;
const allowedOrigins = resolveAllowedOrigins();
// The agent binds loopback only, so a legitimate Host is always a loopback
// hostname (localhost / 127.0.0.1). Enforcing the allowlist blocks a page whose
// DNS was rebound to 127.0.0.1 from reading /control or /db over same-origin
// GETs. Extend via AGENT_ALLOWED_HOSTS when fronted by a proxy on another host.
const allowedHosts = resolveAllowedHosts();
const token = process.env.AGENT_TOKEN || undefined;
const controlTarget = resolveServerControlTarget(process.env);

const handle = createFetchHandler(mgr, { allowedOrigins, allowedHosts, token, controlTarget });
const stopAccepting: Array<() => unknown | Promise<unknown>> = [];
installAgentShutdown(handle, { stopAccepting });

const server = Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  fetch: handle,
});
stopAccepting.push(() => server.stop());

logger.info(
  {
    url: `http://127.0.0.1:${PORT}/control`,
    allowedOrigins,
    allowedHosts,
    tokenAuth: Boolean(token),
    serverManagement: controlTarget.mode,
  },
  'bunqueue dashboard control agent ready'
);
