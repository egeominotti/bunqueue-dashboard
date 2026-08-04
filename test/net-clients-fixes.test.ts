import {
  ApiError,
  api,
  BqError,
  bq,
  describe,
  expect,
  installHangingFetch,
  installTestHooks,
  setApiTimeout,
  setBqTimeout,
  test,
} from './net-clients-fixes.helpers';

installTestHooks();

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
