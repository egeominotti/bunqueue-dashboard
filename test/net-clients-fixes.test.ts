import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { ApiError, api, setRequestTimeoutMs as setApiTimeout } from '../src/lib/api';
import { BqError, bq, setRequestTimeoutMs as setBqTimeout } from '../src/lib/bq';
import { streamEvents } from '../src/lib/sse';
import { fetchHealthWithTimeout, isValidBaseUrl } from '../src/pages/Settings';

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

  test('bq composes a caller cancellation signal with its deadline', async () => {
    setBqTimeout(5);
    installHangingFetch();
    const lifecycle = new AbortController();
    const err = await bq.overview({ signal: lifecycle.signal }).catch((e: unknown) => e);
    expect(lifecycle.signal.aborted).toBe(false);
    expect(err).toBeInstanceOf(BqError);
    expect((err as BqError).message).toBe('Request timed out');
  });

  test('deadlines cover a response body that stalls after headers', async () => {
    const bodyStallFetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), {
            once: true,
          });
        },
      });
      return Promise.resolve(
        new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } })
      );
    }) as typeof fetch;
    globalThis.fetch = bodyStallFetch;
    setBqTimeout(5);
    const bqError = await bq.overview().catch((e: unknown) => e);
    expect(bqError).toBeInstanceOf(BqError);
    expect((bqError as BqError).message).toBe('Request timed out');

    globalThis.fetch = bodyStallFetch;
    setApiTimeout(5);
    const apiError = await api.overview().catch((e: unknown) => e);
    expect(apiError).toBeInstanceOf(ApiError);
    expect((apiError as ApiError).message).toBe('Request timed out');
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
  test('read requests do not force a JSON Content-Type preflight', async () => {
    let seen: Headers | undefined;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      seen = new Headers(init?.headers);
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    }) as typeof fetch;
    await api.health();
    expect(seen?.has('Content-Type')).toBe(false);
  });

  test('body requests set JSON Content-Type while preserving HeadersInit overrides', async () => {
    let seen: Headers | undefined;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      seen = new Headers(init?.headers);
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    }) as typeof fetch;
    await api.clean('q', 0, 1);
    expect(seen?.get('Content-Type')).toBe('application/json');
  });

  test('api.health() returns the structured disk-full body carried by HTTP 503', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ ok: false, status: 'degraded', storage: { diskFull: true } }),
          {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      )) as typeof fetch;
    const health = await api.health();
    expect(health.ok).toBe(false);
    expect(health.status).toBe('degraded');
  });

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

describe('Settings health probe', () => {
  test('accepts explicit API prefixes but rejects root, protocol-relative, and credential URLs', () => {
    expect(isValidBaseUrl('/api')).toBe(true);
    expect(isValidBaseUrl('https://queue.example.com/api')).toBe(true);
    expect(isValidBaseUrl('/')).toBe(false);
    expect(isValidBaseUrl('//queue.example.com')).toBe(false);
    expect(isValidBaseUrl('https://user:secret@queue.example.com')).toBe(false);
  });

  test('rejects a successful but schema-less response instead of claiming Connected', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ version: '2.8.55' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )) as typeof fetch;
    await expect(fetchHealthWithTimeout('/health', {}, 100)).rejects.toThrow(
      'Malformed health response'
    );
  });

  test('accepts the structured degraded body returned with HTTP 503', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            ok: false,
            status: 'degraded',
            uptime: 42,
            version: '2.8.55',
          }),
          {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      )) as typeof fetch;
    const result = await fetchHealthWithTimeout('/health', {}, 100);
    expect(result.health).toEqual({
      ok: false,
      status: 'degraded',
      uptime: 42,
      version: '2.8.55',
    });
  });

  test('requires a coherent Bunqueue health fingerprint with robust field types', async () => {
    const malformed = [
      { ok: true, status: 'healthy', uptime: -1, version: '2.8.55' },
      { ok: true, status: 'healthy', uptime: 1.5, version: '2.8.55' },
      { ok: true, status: 'healthy', uptime: '42', version: '2.8.55' },
      { ok: true, status: 'up', uptime: 42, version: '2.8.55' },
      { ok: true, status: 'healthy', uptime: 42, version: 'latest' },
      { ok: false, status: 'healthy', uptime: 42, version: '2.8.55' },
      { ok: true, status: 'degraded', uptime: 42, version: '2.8.55' },
    ];
    for (const body of malformed) {
      globalThis.fetch = (() => Promise.resolve(Response.json(body))) as typeof fetch;
      await expect(fetchHealthWithTimeout('/health', {}, 100)).rejects.toThrow(
        'Malformed health response'
      );
    }
  });

  test('caller cancellation rejects even when a fetch test double ignores AbortSignal', async () => {
    globalThis.fetch = (() => new Promise<Response>(() => {})) as typeof fetch;
    const controller = new AbortController();
    const pending = fetchHealthWithTimeout('/health', { signal: controller.signal }, 1000);
    controller.abort(new DOMException('edited connection', 'AbortError'));
    await expect(pending).rejects.toThrow('edited connection');
  });
});

describe('401 credential correlation', () => {
  test('auth:required carries the Authorization value the failing request used', async () => {
    const prev = (globalThis as { window?: unknown }).window;
    const target = new EventTarget();
    (globalThis as { window?: unknown }).window = target;
    try {
      const seen: Array<{ auth?: string; target?: string }> = [];
      target.addEventListener('auth:required', (e) => {
        seen.push((e as CustomEvent<{ auth?: string; target?: string }>).detail);
      });
      globalThis.fetch = () =>
        Promise.resolve(new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }));
      useConnectionStore.getState().setToken('stale-tok');
      await expect(bq.stats()).rejects.toThrow('unauthorized');
      expect(seen).toEqual([{ scope: 'server', auth: 'Bearer stale-tok', target: 'http://srv' }]);
    } finally {
      if (prev === undefined) delete (globalThis as { window?: unknown }).window;
      else (globalThis as { window?: unknown }).window = prev;
    }
  });

  test('bq reads do not add Content-Type and 401 correlation uses the effective Headers value', async () => {
    const prev = (globalThis as { window?: unknown }).window;
    const target = new EventTarget();
    (globalThis as { window?: unknown }).window = target;
    try {
      let seenHeaders: Headers | undefined;
      const seenAuth: Array<{ auth?: string; target?: string }> = [];
      target.addEventListener('auth:required', (e) => {
        seenAuth.push((e as CustomEvent<{ auth?: string; target?: string }>).detail);
      });
      globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
        seenHeaders = new Headers(init?.headers);
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
        );
      }) as typeof fetch;
      useConnectionStore.getState().setToken('effective-token');
      await expect(bq.stats()).rejects.toThrow('unauthorized');
      expect(seenHeaders?.has('Content-Type')).toBe(false);
      expect(seenAuth).toEqual([
        { scope: 'server', auth: 'Bearer effective-token', target: 'http://srv' },
      ]);
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
      return Promise.resolve(
        new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      );
    }) as typeof fetch;
    await expect(
      streamEvents('/events', () => {}, new AbortController().signal, 10)
    ).rejects.toThrow('SSE idle timeout');
  });
});
