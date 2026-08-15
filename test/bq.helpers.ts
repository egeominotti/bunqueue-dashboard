import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  DB_EXPORT_MAX_BYTES as AGENT_EXPORT_MAX_BYTES,
  DB_EXPORT_MAX_ROWS as AGENT_EXPORT_MAX_ROWS,
} from '../agent/db';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import {
  BqError,
  type BulkJobBody,
  bq,
  bulkJobPayloadBudgetError,
  DB_EXPORT_MAX_BYTES as CLIENT_EXPORT_MAX_BYTES,
  DB_EXPORT_MAX_ROWS as CLIENT_EXPORT_MAX_ROWS,
  captureServerRequestTarget,
  createServerTargetClient,
  getJobAtTarget,
  MAX_BULK_JOB_COUNT,
  resolveAgentBase,
  SAFE_AGENT_BASE,
} from '../src/lib/bq';

// Unit tests for the core API client's transport semantics (src/lib/bq.ts
// `call()`), exercised through the public `bq` surface with a mocked fetch:
// error mapping, the HTTP-200-{ok:false} convention and its health() opt-out,
// auth-header scoping (server vs agent), 401 → auth:required event scoping,
// and URL/body construction for representative endpoints.

interface Captured {
  url: string;
  init?: RequestInit;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const fetchHarness = {
  calls: [] as Captured[],
  responder: (_url: string, _init?: RequestInit) => json({ ok: true }),
};

const realFetch = globalThis.fetch;

function lastCall(): Captured {
  const c = fetchHarness.calls.at(-1);
  if (!c) throw new Error('no fetch captured');
  return c;
}

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  if (!init?.headers) return undefined;
  return new Headers(init.headers).get(name) ?? undefined;
}

export type { BulkJobBody, Captured };
export {
  AGENT_EXPORT_MAX_BYTES,
  AGENT_EXPORT_MAX_ROWS,
  afterEach,
  BqError,
  beforeEach,
  bq,
  bulkJobPayloadBudgetError,
  CLIENT_EXPORT_MAX_BYTES,
  CLIENT_EXPORT_MAX_ROWS,
  captureServerRequestTarget,
  createServerTargetClient,
  describe,
  expect,
  fetchHarness,
  getJobAtTarget,
  headerOf,
  json,
  lastCall,
  MAX_BULK_JOB_COUNT,
  realFetch,
  resolveAgentBase,
  SAFE_AGENT_BASE,
  test,
  useConnectionStore,
};

export function installTestHooks() {
  beforeEach(() => {
    fetchHarness.calls = [];
    fetchHarness.responder = () => json({ ok: true });
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      fetchHarness.calls.push({ url: String(input), init });
      return Promise.resolve(fetchHarness.responder(String(input), init));
    }) as typeof fetch;
    useConnectionStore.setState({ baseUrl: 'http://srv', token: '', agentToken: '' });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    // Reset the shared singleton so a later test file can't inherit this file's
    // baseUrl/token mutations (bun test shares the module graph across files).
    useConnectionStore.setState({ baseUrl: '/api', token: '', agentToken: '' });
  });
}
