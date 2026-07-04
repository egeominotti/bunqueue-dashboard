import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { BqError, bq } from '../src/lib/bq';

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

let calls: Captured[] = [];
let responder: (url: string, init?: RequestInit) => Response;
const realFetch = globalThis.fetch;

function lastCall(): Captured {
  const c = calls.at(-1);
  if (!c) throw new Error('no fetch captured');
  return c;
}

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  return (init?.headers as Record<string, string> | undefined)?.[name];
}

beforeEach(() => {
  calls = [];
  responder = () => json({ ok: true });
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return Promise.resolve(responder(String(input), init));
  }) as typeof fetch;
  useConnectionStore.setState({ baseUrl: 'http://srv', token: '', agentToken: '' });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  // Reset the shared singleton so a later test file can't inherit this file's
  // baseUrl/token mutations (bun test shares the module graph across files).
  useConnectionStore.setState({ baseUrl: '/api', token: '', agentToken: '' });
});

describe('bq transport (call)', () => {
  test('resolves the parsed body on a plain ok response', async () => {
    responder = () => json({ ok: true, uptime: 42 });
    const res = await bq.overview();
    expect((res as { uptime?: number }).uptime).toBe(42);
    expect(lastCall().url).toBe('http://srv/dashboard');
  });

  test('maps an HTTP error with a JSON error body to BqError(message, status)', async () => {
    responder = () => json({ ok: false, error: 'queue not found' }, 404);
    const err = await bq.counts('nope').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BqError);
    expect((err as BqError).message).toBe('queue not found');
    expect((err as BqError).status).toBe(404);
  });

  test('maps an HTTP error with a non-JSON body to "HTTP <status>"', async () => {
    responder = () => new Response('<html>gateway timeout</html>', { status: 504 });
    const err = await bq.stats().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BqError);
    expect((err as BqError).message).toBe('HTTP 504');
  });

  test('204 and empty 200 bodies resolve as undefined instead of a parse error', async () => {
    responder = () => new Response(null, { status: 204 });
    await expect(bq.cancelJob('j1')).resolves.toBeUndefined();
    responder = () => new Response('', { status: 200 });
    await expect(bq.pause('q')).resolves.toBeUndefined();
  });

  test('a 2xx with invalid JSON surfaces as BqError, not a raw SyntaxError', async () => {
    responder = () => new Response('not-json{', { status: 200 });
    const err = await bq.stats().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BqError);
    expect((err as BqError).message).toBe('Invalid JSON response (HTTP 200)');
  });

  test('HTTP 200 with {ok:false} throws (logical failure), defaulting the message', async () => {
    responder = () => json({ ok: false, error: 'job already finished' });
    await expect(bq.retryJob('j1')).rejects.toThrow('job already finished');
    responder = () => json({ ok: false });
    await expect(bq.retryJob('j1')).rejects.toThrow('Operation failed');
  });

  test('health() opts out of strict mode: ok:false is data, not an error', async () => {
    responder = () => json({ ok: false, version: '1.0.0' });
    const health = await bq.health();
    expect(health.ok).toBe(false);
    expect(health.version).toBe('1.0.0');
  });
});

describe('bq auth scoping', () => {
  test('server token goes to server calls only; agent token to agent calls only', async () => {
    useConnectionStore.getState().setToken('srv-tok');
    useConnectionStore.getState().setAgentToken('agent-tok');

    await bq.stats();
    expect(headerOf(lastCall().init, 'Authorization')).toBe('Bearer srv-tok');

    await bq.control.status();
    const agentCall = lastCall();
    expect(agentCall.url).toBe('http://localhost:6800/control/status');
    expect(headerOf(agentCall.init, 'Authorization')).toBe('Bearer agent-tok');
  });

  test('a 401 dispatches auth:required scoped to the backend that rejected', async () => {
    // Swap in a bare EventTarget as `window`, restoring whatever was there
    // before (test files share one global scope — another file may have
    // installed a happy-dom window that must survive this test).
    const prev = (globalThis as { window?: unknown }).window;
    const target = new EventTarget();
    (globalThis as { window?: unknown }).window = target;
    try {
      const scopes: string[] = [];
      target.addEventListener('auth:required', (e) => {
        scopes.push((e as CustomEvent<{ scope: string }>).detail.scope);
      });
      responder = () => json({ error: 'unauthorized' }, 401);
      await expect(bq.stats()).rejects.toThrow('unauthorized');
      await expect(bq.control.status()).rejects.toThrow('unauthorized');
      expect(scopes).toEqual(['server', 'agent']);
    } finally {
      if (prev === undefined) {
        delete (globalThis as { window?: unknown }).window;
      } else {
        (globalThis as { window?: unknown }).window = prev;
      }
    }
  });
});

describe('bq request construction', () => {
  test('path segments are URI-encoded (queue/job names with special chars)', async () => {
    await bq.dlq('my/queue #1');
    expect(lastCall().url).toBe('http://srv/queues/my%2Fqueue%20%231/dlq?limit=100&offset=0');
  });

  test('jobsList builds states/limit/offset query params', async () => {
    responder = () => json({ ok: true, jobs: [] });
    await bq.jobsList('q1', ['waiting', 'active'], 25, 50);
    expect(lastCall().url).toBe(
      'http://srv/queues/q1/jobs/list?states=waiting%2Cactive&limit=25&offset=50'
    );
  });

  test('rate-limit and concurrency send the server-verified body shapes', async () => {
    await bq.setRateLimit('q1', 100);
    expect(lastCall().init?.method).toBe('PUT');
    expect(lastCall().init?.body).toBe(JSON.stringify({ limit: 100 }));

    await bq.setConcurrency('q1', 4);
    expect(lastCall().init?.body).toBe(JSON.stringify({ concurrency: 4 }));
  });

  test('optional bodies are omitted, not sent as "undefined"', async () => {
    responder = () => json({ ok: true, count: 0 });
    await bq.retryDlq('q1');
    expect(lastCall().init?.body).toBeUndefined();
    await bq.retryDlq('q1', 'job-9');
    expect(lastCall().init?.body).toBe(JSON.stringify({ jobId: 'job-9' }));
  });

  test('db.rows composes paging, ordering and filter params for the agent', async () => {
    responder = () => json({ ok: true, rows: [] });
    await bq.db.rows('jobs', 50, 100, 'id', 'desc', {
      column: 'state',
      op: 'eq',
      value: 'failed',
    });
    expect(lastCall().url).toBe(
      'http://localhost:6800/db/tables/jobs?limit=50&offset=100&orderBy=id&dir=desc&fcol=state&fop=eq&fval=failed'
    );
  });

  test('eventsUrl tracks the live baseUrl and encodes the queue name', () => {
    expect(bq.eventsUrl()).toBe('http://srv/events');
    expect(bq.eventsUrl('a/b')).toBe('http://srv/events/queues/a%2Fb');
    useConnectionStore.getState().setBaseUrl('http://other/');
    expect(bq.eventsUrl()).toBe('http://other/events');
  });
});
