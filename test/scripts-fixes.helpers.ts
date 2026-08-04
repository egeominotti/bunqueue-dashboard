/**
 * Regression tests for the audited scripts/ findings:
 *   serve.ts — non-loopback control-plane gate, same-origin Origin handling,
 *              /api 502 on an unreachable upstream, `//x:y` path crash;
 *   dev.ts   — a throwing spawn must not orphan already-started children;
 *   check-coverage.ts — a malformed lcov must fail, not pass.
 */
import { describe, expect, it, mock } from 'bun:test';

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import { ProcessManager } from '../agent/manager';

import { createFetchHandler, isHostAllowed } from '../agent/server';

import {
  agentSubUrl,
  apiTokenOk,
  createServeHandler,
  isLoopbackBind,
  isLoopbackHost,
  isRemoteBridgeRequest,
  RESPONSE_SECURITY_HEADERS,
  remoteBridgeRequiresToken,
  remoteControlEnabled,
  resolveServeAllowedHosts,
  type ServeHandlerOptions,
} from '../scripts/serve';

const ALLOWED = ['http://localhost:5273', 'http://localhost:8080', 'http://127.0.0.1:8080'];

/** Echo agent: reports what the bridge actually forwarded. */
const echoAgent = async (req: Request): Promise<Response> =>
  Response.json({
    url: req.url,
    origin: req.headers.get('origin'),
    method: req.method,
    body: req.method === 'POST' ? await req.text() : '',
  });

function handler(over: Partial<ServeHandlerOptions> = {}) {
  return createServeHandler({
    api: 'http://127.0.0.1:6790',
    indexHtml: '<html>ok</html>',
    assets: {},
    agentHandle: echoAgent,
    remoteAgentHandle: echoAgent,
    allowedOrigins: ALLOWED,
    agentBridge: true,
    agentTokenConfigured: false,
    ...over,
  });
}

async function within<T>(promise: Promise<T>, ms = 250): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Operation did not settle within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function realAgentBridge({
  token,
  remoteBridgePolicy = false,
  trustProxy = false,
}: {
  token?: string;
  remoteBridgePolicy?: boolean;
  trustProxy?: boolean;
} = {}) {
  const manager = new ProcessManager();
  const allowedHosts = ['localhost', '127.0.0.1', 'dashboard.example.com', 'dashboard-internal'];
  const localAgent = createFetchHandler(manager, {
    allowedOrigins: ALLOWED,
    allowedHosts,
    token,
  });
  const remoteAgent = createFetchHandler(manager, {
    allowedOrigins: ALLOWED,
    allowedHosts,
    token,
    requireTokenForAll: true,
  });
  return {
    manager,
    handle: createServeHandler({
      api: 'http://127.0.0.1:6790',
      indexHtml: '<html>ok</html>',
      assets: {},
      agentHandle: localAgent,
      remoteAgentHandle: remoteAgent,
      allowedOrigins: ALLOWED,
      allowedHosts,
      agentBridge: !remoteBridgePolicy || Boolean(token),
      agentTokenConfigured: Boolean(token),
      remoteBridgePolicy,
      trustProxy,
    }),
  };
}

export type { ServeHandlerOptions };
export {
  ALLOWED,
  agentSubUrl,
  apiTokenOk,
  createFetchHandler,
  createServeHandler,
  describe,
  echoAgent,
  expect,
  handler,
  isHostAllowed,
  isLoopbackBind,
  isLoopbackHost,
  isRemoteBridgeRequest,
  it,
  join,
  mkdtempSync,
  mock,
  ProcessManager,
  RESPONSE_SECURITY_HEADERS,
  readFileSync,
  realAgentBridge,
  remoteBridgeRequiresToken,
  remoteControlEnabled,
  resolveServeAllowedHosts,
  tmpdir,
  within,
  writeFileSync,
};
