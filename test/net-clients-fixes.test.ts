import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { ApiError, api, setRequestTimeoutMs as setApiTimeout } from '../src/lib/api';
import { BqError, bq, setRequestTimeoutMs as setBqTimeout } from '../src/lib/bq';
import { streamEvents } from '../src/lib/sse';

// Regression tests for the "net-clients" audit package: transport deadlines in
// both HTTP clients, the /storage strict-mode opt-out, the api.ts JSON parse
// guard, 401 credential correlation, and SSE body cleanup / idle liveness.

const realFetch = globalThis.fetch;

beforeEach(() => {
  useConnectionStore.setState({ baseUrl: 'http://srv', token: '', agentToken: '' });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  setBqTimeout(30_000);
  setApiTimeout(30_000);
  useConnectionStore.setState({ baseUrl: '/api', token: '', agentToken: '' });
});

/** A server that accepts the connection and then never answers. */
function installHangingFetch() {
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return; // hangs forever — the pre-fix behaviour
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    })) as typeof fetch;
}

describe('request deadline', () => {
  test('bq: a hung server rejects with BqError("Request timed out", 0) instead of hanging', async () => {
    setBqTimeout(5);
    installHangingFetch();
    const err = await bq.overview().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BqError);
    expect((err as BqError).message).toBe('Request timed out');
    expect((err as BqError).status).toBe(0);
  });

  test('api: a hung server rejects with ApiError("Request timed out", 0)', async () => {
    setApiTimeout(5);
    installHangingFetch();
    const err = await api.overview().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe('Request timed out');
    expect((err as ApiError).status).toBe(0);
  });
});

describe('storage strict-mode opt-out', () => {
  test('bq.storage() resolves a disk-full {ok:false} body as data, not an error', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: false, data: { diskFull: true, error: 'ENOSPC' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )) as typeof fetch;
    const res = await bq.storage();
    expect(res.ok).toBe(false);
    expect(res.data.diskFull).toBe(true);
  });
});

describe('api.request JSON guard', () => {
  test('a 200 with an HTML body surfaces as ApiError with the status, not a SyntaxError', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response('<!doctype html><html></html>', { status: 200 })
      )) as typeof fetch;
    const err = await api.health().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe('Invalid JSON response (HTTP 200)');
    expect((err as ApiError).status).toBe(200);
  });

  test('a 200 with an empty body resolves as undefined', async () => {
    globalThis.fetch = (() => Promise.resolve(new Response('', { status: 200 }))) as typeof fetch;
    await expect(api.pause('q')).resolves.toBeUndefined();
  });
});

describe('401 credential correlation', () => {
  test('auth:required carries the Authorization value the failing request used', async () => {
    const prev = (globalThis as { window?: unknown }).window;
    const target = new EventTarget();
    (globalThis as { window?: unknown }).window = target;
    try {
      const seen: (string | undefined)[] = [];
      target.addEventListener('auth:required', (e) => {
        seen.push((e as CustomEvent<{ auth?: string }>).detail.auth);
      });
      globalThis.fetch = () =>
        Promise.resolve(new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }));
      useConnectionStore.getState().setToken('stale-tok');
      await expect(bq.stats()).rejects.toThrow('unauthorized');
      expect(seen).toEqual(['Bearer stale-tok']);
    } finally {
      if (prev === undefined) delete (globalThis as { window?: unknown }).window;
      else (globalThis as { window?: unknown }).window = prev;
    }
  });
});

describe('streamEvents cleanup and liveness', () => {
  test('a failed connect cancels the unread response body', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    globalThis.fetch = (() =>
      Promise.resolve(new Response(stream, { status: 401 }))) as typeof fetch;
    await expect(streamEvents('/events', () => {}, new AbortController().signal)).rejects.toThrow(
      'SSE connect failed: HTTP 401'
    );
    expect(cancelled).toBe(true);
  });

  test('an ok response with no body reports the body, not a bogus "HTTP 200"', async () => {
    globalThis.fetch = (() => Promise.resolve(new Response(null, { status: 200 }))) as typeof fetch;
    await expect(streamEvents('/events', () => {}, new AbortController().signal)).rejects.toThrow(
      'SSE connect failed: empty response body'
    );
  });

  test('a silent (half-open) stream rejects on the idle deadline instead of hanging', async () => {
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          // Real fetch errors the body when the request signal aborts.
          init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), {
            once: true,
          });
        },
      });
      return Promise.resolve(new Response(stream, { status: 200 }));
    }) as typeof fetch;
    await expect(
      streamEvents('/events', () => {}, new AbortController().signal, 10)
    ).rejects.toThrow('SSE idle timeout');
  });
});
