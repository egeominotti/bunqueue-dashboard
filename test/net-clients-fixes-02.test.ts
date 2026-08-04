import {
  bq,
  describe,
  expect,
  fetchHealthWithTimeout,
  installTestHooks,
  isValidBaseUrl,
  test,
  useConnectionStore,
} from './net-clients-fixes.helpers';

installTestHooks();

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
