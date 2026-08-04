import {
  describe,
  expect,
  handler,
  it,
  RESPONSE_SECURITY_HEADERS,
  readFileSync,
} from './scripts-fixes.helpers';

describe('serve.ts /api proxy', () => {
  const apiToken = 'api-secret';

  const authorization = { Authorization: `Bearer ${apiToken}` };

  it('admits a mutation from the served host over https (TLS-terminating proxy)', async () => {
    // The binary only ever speaks plain http, so behind a reverse proxy the
    // browser's Origin is https:// while req.url is http://. Comparing full
    // origins 403s every pause/retry/add-job on a proxied deployment while
    // read-only GETs (no Origin) keep working — healthy-looking, broken on click.
    const res = await handler({ api: 'http://127.0.0.1:1', apiToken })(
      new Request('http://dash.example.com/api/queues/x/pause', {
        method: 'POST',
        headers: { ...authorization, origin: 'https://dash.example.com' },
      })
    );
    expect(res.status).toBe(502); // passed the gate; only the upstream is down
  });

  it('honours x-forwarded-host when the proxy rewrites Host and TRUST_PROXY is set', async () => {
    const res = await handler({ api: 'http://127.0.0.1:1', apiToken, trustProxy: true })(
      new Request('http://internal-backend:8080/api/queues/x/pause', {
        method: 'POST',
        headers: {
          origin: 'https://dash.example.com',
          'x-forwarded-host': 'dash.example.com',
          ...authorization,
        },
      })
    );
    expect(res.status).toBe(502);
  });

  it('403s an Origin that self-matches via its own x-forwarded-host', async () => {
    // X-Forwarded-Host is client-settable unless a proxy owns it, so believing
    // it by default lets any direct caller declare itself same-origin by
    // sending its own Origin AND a matching forwarded host. Hence TRUST_PROXY:
    // without it the header is ignored outright (see the test below).
    const res = await handler({ api: 'http://127.0.0.1:1' })(
      new Request('http://dash.example.com/api/queues/x/pause', {
        method: 'POST',
        headers: { origin: 'https://evil.example', 'x-forwarded-host': 'evil.example' },
      })
    );
    expect(res.status).toBe(403);
  });

  it('matches a forwarded host case-insensitively', async () => {
    const res = await handler({ api: 'http://127.0.0.1:1', apiToken, trustProxy: true })(
      new Request('http://internal-backend:8080/api/queues/x/pause', {
        method: 'POST',
        headers: {
          ...authorization,
          origin: 'https://dash.example.com',
          'x-forwarded-host': 'Dash.Example.com',
        },
      })
    );
    expect(res.status).toBe(502); // passed the gate; only the upstream is down
  });

  it('ignores x-forwarded-host entirely without TRUST_PROXY', async () => {
    const res = await handler({ api: 'http://127.0.0.1:1' })(
      new Request('http://internal-backend:8080/api/queues/x/pause', {
        method: 'POST',
        headers: { origin: 'https://dash.example.com', 'x-forwarded-host': 'dash.example.com' },
      })
    );
    expect(res.status).toBe(403);
  });

  it('still 403s a cross-site Origin that merely claims a forwarded host', async () => {
    const res = await handler({ api: 'http://127.0.0.1:1' })(
      new Request('http://dash.example.com/api/queues/x/pause', {
        method: 'POST',
        headers: { origin: 'https://evil.example', 'x-forwarded-host': 'dash.example.com' },
      })
    );
    expect(res.status).toBe(403);
  });
});

describe('serve.ts static routes', () => {
  it('serves index.html for an unknown route and 404s a missing asset', async () => {
    const h = handler();
    expect(await (await h(new Request('http://localhost:8080/queues'))).text()).toBe(
      '<html>ok</html>'
    );
    expect((await h(new Request('http://localhost:8080/assets/gone.js'))).status).toBe(404);
  });

  it('rejects a rebound Host when allowedHosts is enforced', async () => {
    const res = await handler({ allowedHosts: ['localhost', '127.0.0.1'] })(
      new Request('http://evil.example/agent/control/status', {
        headers: { host: 'evil.example' },
      })
    );
    expect(res.status).toBe(403);
  });

  it('sets the same anti-embedding and content-sniffing headers as the Docker image', async () => {
    const res = await handler()(new Request('http://localhost:8080/'));
    for (const [name, value] of Object.entries(RESPONSE_SECURITY_HEADERS)) {
      expect(res.headers.get(name)).toBe(value);
    }

    const caddyfile = readFileSync(new URL('../docker/Caddyfile', import.meta.url), 'utf8');
    for (const [name, value] of Object.entries(RESPONSE_SECURITY_HEADERS)) {
      expect(caddyfile).toContain(`${name} "${value}"`);
    }
  });
});
