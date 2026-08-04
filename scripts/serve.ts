#!/usr/bin/env bun
/**
 * Standalone dashboard: serves embedded assets, proxies /api, and exposes the
 * local control agent through a same-origin /agent bridge.
 */
import { logger } from '../agent/logger';
import { BunqueueBackupRunner } from '../agent/backup/runner';
import { setBackupWorkerUrl } from '../agent/backup/workerFactory';
import { setQueryWorkerUrl } from '../agent/db';
import { QueueOperationsRuntime } from '../agent/queue/runtime';
import { AgentLifecycleGate, createFetchHandler, resolveAllowedOrigins } from '../agent/server';
import { installAgentShutdown } from '../agent/shutdown';
import { WorkflowRuntime } from '../agent/workflow/runtime';
import { createServeHandler } from './serveHandler';
import {
  isLoopbackBind,
  remoteBridgeRequiresToken,
  remoteControlEnabled,
  resolveServeAllowedHosts,
  withSecurityHeaders,
} from './servePolicy';

export { createServeHandler } from './serveHandler';
export {
  agentSubUrl,
  apiTokenOk,
  isLoopbackBind,
  isLoopbackHost,
  isRemoteBridgeRequest,
  RESPONSE_SECURITY_HEADERS,
  remoteBridgeRequiresToken,
  remoteControlEnabled,
  resolveServeAllowedHosts,
  type ServeHandlerOptions,
  withSecurityHeaders,
} from './servePolicy';

async function main(): Promise<void> {
  // Compiled Bun entrypoints load the query worker from the embedded bundle.
  const compiled = import.meta.url.includes('/$bunfs/');
  setQueryWorkerUrl(
    compiled
      ? new URL('/$bunfs/root/agent/dbQueryWorker.js', 'file:///').href
      : new URL('../agent/dbQueryWorker.ts', import.meta.url).href
  );
  setBackupWorkerUrl(
    compiled
      ? new URL('/$bunfs/root/agent/backup/standaloneWorker.js', 'file:///').href
      : null
  );

  const port = Number(process.env.PORT) || 8080;
  const host = process.env.BIND_ADDR || '127.0.0.1';
  const api = (process.env.BUNQUEUE_URL || 'http://localhost:6790').replace(/\/$/, '');
  const agentPort = Number(process.env.AGENT_PORT) || 6800;
  const allowedOrigins = Array.from(
    new Set([
      ...resolveAllowedOrigins(),
      `http://localhost:${port}`,
      `http://127.0.0.1:${port}`,
    ])
  );
  const remoteBridgePolicy = remoteBridgeRequiresToken(isLoopbackBind(host), process.env);
  const allowedHosts = resolveServeAllowedHosts(host, allowedOrigins, process.env);
  const token = process.env.AGENT_TOKEN?.trim() || undefined;
  const apiToken = process.env.BUNQUEUE_TOKEN?.trim() || undefined;
  const agentBridge = remoteControlEnabled(remoteBridgePolicy, process.env);
  if (!agentBridge) {
    logger.warn(
      { bind: host, remoteBridgePolicy },
      'remote or proxied bridge policy without AGENT_TOKEN — /agent is disabled (403)'
    );
  }
  if (remoteBridgePolicy && !apiToken) {
    logger.warn(
      { apiProxy: api },
      'remote or proxied bridge policy without BUNQUEUE_TOKEN — /api is disabled (403)'
    );
  } else if (remoteBridgePolicy) {
    logger.info(
      { apiProxy: api },
      'remote or proxied /api requires the configured BUNQUEUE_TOKEN bearer'
    );
  }

  // Complete every awaited startup step before installing handlers/listeners.
  const { ASSETS } = await import('./embedded.gen');
  const indexHtml = (await Bun.file(ASSETS['/index.html']).text()).replace(
    '</head>',
    "<script>window.__BUNQUEUE_AGENT_URL__='/agent'</script></head>"
  );

  // Keep ProcessManager out of policy-only test imports.
  const { ProcessManager } = await import('../agent/manager');
  const mgr = new ProcessManager();
  const workflowRuntime = new WorkflowRuntime();
  const backupRunner = new BunqueueBackupRunner();
  const queueRuntime = new QueueOperationsRuntime();
  const lifecycle = new AgentLifecycleGate();
  const localAgentHandle = createFetchHandler(
    mgr,
    { allowedOrigins, allowedHosts, token },
    workflowRuntime,
    backupRunner,
    queueRuntime,
    lifecycle
  );
  const remoteAgentHandle = createFetchHandler(
    mgr,
    { allowedOrigins, allowedHosts, token, requireTokenForAll: true },
    workflowRuntime,
    backupRunner,
    queueRuntime,
    lifecycle
  );
  const proxyShutdown = new AbortController();
  const stopAccepting: Array<() => unknown | Promise<unknown>> = [
    () => proxyShutdown.abort(new Error('Dashboard is shutting down')),
  ];
  // Register before opening listeners so no startup window uses default signal handling.
  installAgentShutdown(localAgentHandle, { stopAccepting });
  const onError = () => withSecurityHeaders(new Response('Internal error', { status: 500 }));

  const agentServer = Bun.serve({
    port: agentPort,
    hostname: '127.0.0.1',
    fetch: localAgentHandle,
    error: onError,
  });
  stopAccepting.push(() => agentServer.stop());

  const dashboardServer = Bun.serve({
    port,
    hostname: host,
    fetch: createServeHandler({
      api,
      indexHtml,
      assets: ASSETS,
      agentHandle: localAgentHandle,
      remoteAgentHandle,
      allowedOrigins,
      allowedHosts,
      agentBridge,
      agentTokenConfigured: Boolean(token),
      apiToken,
      apiShutdownSignal: proxyShutdown.signal,
      remoteBridgePolicy,
      trustProxy: process.env.TRUST_PROXY === '1',
    }),
    error: onError,
  });
  stopAccepting.push(() => dashboardServer.stop());

  logger.info(
    {
      dashboard: `http://${host}:${port}`,
      apiProxy: api,
      agent: `http://127.0.0.1:${agentPort}/control`,
      agentBridge,
      remoteBridgePolicy,
      allowedHosts,
    },
    'bunqueue dashboard (standalone) ready'
  );
}

if (import.meta.main) await main();
