import { apiTokenOk, describe, expect, handler, it, within } from './scripts-fixes.helpers';

describe('serve.ts /api proxy', () => {
  const apiToken = 'api-secret';

  const authorization = { Authorization: `Bearer ${apiToken}` };

  it('compares the complete bearer token exactly', () => {
    expect(
      apiTokenOk(
        new Request('http://localhost/api', { headers: { Authorization: 'Bearer api-secret' } }),
        apiToken
      )
    ).toBe(true);
    expect(
      apiTokenOk(
        new Request('http://localhost/api', { headers: { Authorization: 'Bearer API-SECRET' } }),
        apiToken
      )
    ).toBe(false);
    expect(apiTokenOk(new Request('http://localhost/api'), apiToken)).toBe(false);
    expect(
      apiTokenOk(
        new Request('http://localhost/api', { headers: { Authorization: 'Bearer api-secret' } }),
        undefined
      )
    ).toBe(false);
  });

  it('returns a JSON 502 when bunqueue is unreachable', async () => {
    // Port 1 is never a bunqueue server: fetch rejects immediately.
    const res = await handler({ api: 'http://127.0.0.1:1' })(
      new Request('http://localhost:8080/api/queues')
    );
    expect(res.status).toBe(502);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('unreachable');
  });

  it('passes the incoming abort signal to the upstream API fetch', async () => {
    const realFetch = globalThis.fetch;
    const controller = new AbortController();
    let upstreamSignal: AbortSignal | null | undefined;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      upstreamSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(init.signal?.reason ?? new Error('aborted')),
          { once: true }
        );
      });
    }) as typeof fetch;
    try {
      const pending = handler()(
        new Request('http://localhost:8080/api/queues', { signal: controller.signal })
      );
      await Promise.resolve();
      expect(upstreamSignal?.aborted).toBe(false);
      controller.abort(new Error('browser disconnected'));
      const res = await within(pending);
      expect(upstreamSignal?.aborted).toBe(true);
      expect(res.status).toBe(502);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('aborts a remote API stream so the dashboard listener can drain on shutdown', async () => {
    const shutdown = new AbortController();
    const upstream = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(': connected\n\n'));
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' } }
        ),
    });
    const dashboard = Bun.serve({
      port: 0,
      fetch: handler({
        api: `http://127.0.0.1:${upstream.port}`,
        apiShutdownSignal: shutdown.signal,
      }),
    });

    try {
      const response = await fetch(`http://127.0.0.1:${dashboard.port}/api/events`);
      expect(response.status).toBe(200);
      shutdown.abort(new Error('terminal dashboard shutdown'));
      await within(dashboard.stop(), 500);
      await response.body?.cancel().catch(() => undefined);
    } finally {
      shutdown.abort();
      await dashboard.stop(true);
      await upstream.stop(true);
    }
  });

  it('owns a settled proxy body when fetch no longer reacts to its abort signal', async () => {
    const realFetch = globalThis.fetch;
    const shutdown = new AbortController();
    let cancelled = false;
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(': connected\n\n'));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } }
      )) as typeof fetch;

    try {
      const response = await handler({ apiShutdownSignal: shutdown.signal })(
        new Request('http://localhost:8080/api/events')
      );
      const reader = response.body?.getReader();
      expect((await reader?.read())?.done).toBe(false);

      shutdown.abort(new Error('terminal dashboard shutdown'));

      expect((await within(reader?.read() ?? Promise.reject(new Error('Missing body')))).done).toBe(
        true
      );
      expect(cancelled).toBe(true);
    } finally {
      shutdown.abort();
      globalThis.fetch = realFetch;
    }
  });

  it('fails a public API request closed when BUNQUEUE_TOKEN is not configured', async () => {
    const res = await handler({ api: 'http://127.0.0.1:1' })(
      new Request('http://dashboard.example.com/api/queues')
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain('BUNQUEUE_TOKEN');
  });

  it('requires the configured bearer before forwarding a public API request', async () => {
    const h = handler({ api: 'http://127.0.0.1:1', apiToken });
    const missing = await h(new Request('http://dashboard.example.com/api/queues'));
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toBe('Bearer');

    const wrong = await h(
      new Request('http://dashboard.example.com/api/queues', {
        headers: { Authorization: 'Bearer wrong' },
      })
    );
    expect(wrong.status).toBe(401);

    const realFetch = globalThis.fetch;
    let forwarded: { url: string; authorization: string | null } | undefined;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      forwarded = {
        url: String(input),
        authorization: new Headers(init?.headers).get('authorization'),
      };
      return Promise.resolve(Response.json({ ok: true }));
    }) as typeof fetch;
    try {
      const allowed = await h(
        new Request('http://dashboard.example.com/api/queues?limit=5', {
          headers: authorization,
        })
      );
      expect(allowed.status).toBe(200);
      expect(forwarded).toEqual({
        url: 'http://127.0.0.1:1/queues?limit=5',
        authorization: `Bearer ${apiToken}`,
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('treats forwarding metadata on a loopback URL as remote API access', async () => {
    const h = handler({ api: 'http://127.0.0.1:1', apiToken });
    const denied = await h(
      new Request('http://localhost:8080/api/queues', {
        headers: { 'X-Forwarded-Host': 'dashboard.example.com' },
      })
    );
    expect(denied.status).toBe(401);

    const allowed = await h(
      new Request('http://localhost:8080/api/queues', {
        headers: { ...authorization, 'X-Forwarded-Host': 'dashboard.example.com' },
      })
    );
    expect(allowed.status).toBe(502);
  });

  it('403s a cross-site request to the admin API proxy', async () => {
    const res = await handler()(
      new Request('http://localhost:8080/api/queues/x/pause', {
        method: 'POST',
        headers: { origin: 'http://evil.example' },
      })
    );
    expect(res.status).toBe(403);
  });
});
