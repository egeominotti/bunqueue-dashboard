import { describe, expect, test } from 'bun:test';
import { ProcessManager } from '../agent/manager';
import {
  corsHeaders,
  createFetchHandler,
  hostnameOf,
  isHostAllowed,
  isOriginAllowed,
  resolveAllowedHosts,
  resolveAllowedOrigins,
} from '../agent/server';

const ALLOWED = ['http://localhost:5273'];

function put(
  url: string,
  body: unknown,
  origin: string | null,
  headers: Record<string, string> = {}
) {
  return new Request(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      ...(origin ? { Origin: origin } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe('agent origin policy', () => {
  test('isOriginAllowed: allowlist + no-origin, rejects others (trailing slash tolerant)', () => {
    expect(isOriginAllowed('http://localhost:5273', ALLOWED)).toBe(true);
    expect(isOriginAllowed('http://localhost:5273/', ALLOWED)).toBe(true);
    expect(isOriginAllowed(null, ALLOWED)).toBe(true); // curl / same process
    expect(isOriginAllowed('https://evil.example', ALLOWED)).toBe(false);
  });

  test('resolveAllowedOrigins merges dev defaults with env, deduped', () => {
    const out = resolveAllowedOrigins({
      AGENT_ALLOWED_ORIGINS: 'https://dash.example/, http://localhost:5273',
    } as NodeJS.ProcessEnv);
    expect(out).toContain('http://localhost:5273');
    expect(out).toContain('http://127.0.0.1:5273');
    expect(out).toContain('https://dash.example');
    expect(out.filter((o) => o === 'http://localhost:5273')).toHaveLength(1);
  });

  test('CORS never returns a wildcard and only reflects allowed origins', () => {
    expect(corsHeaders('http://localhost:5273', ALLOWED)['Access-Control-Allow-Origin']).toBe(
      'http://localhost:5273'
    );
    // disallowed / absent origin → no ACAO at all (browser blocks), never `*`
    expect(
      corsHeaders('https://evil.example', ALLOWED)['Access-Control-Allow-Origin']
    ).toBeUndefined();
    expect(corsHeaders(null, ALLOWED)['Access-Control-Allow-Origin']).toBeUndefined();
    for (const o of [null, 'https://evil.example', 'http://localhost:5273']) {
      expect(corsHeaders(o, ALLOWED)['Access-Control-Allow-Origin']).not.toBe('*');
    }
  });
});

describe('agent DNS-rebinding (Host header) defense', () => {
  test('hostnameOf strips port and unwraps IPv6', () => {
    expect(hostnameOf('localhost:6800')).toBe('localhost');
    expect(hostnameOf('127.0.0.1')).toBe('127.0.0.1');
    expect(hostnameOf('EVIL.EXAMPLE:80')).toBe('evil.example');
    expect(hostnameOf('[::1]:6800')).toBe('::1');
    expect(hostnameOf('[::1]')).toBe('::1');
  });

  // A bare IPv6 literal has no port delimiter — splitting at the first colon
  // both locked the real host out and allowlisted a bogus label ('2001').
  test('hostnameOf keeps an unbracketed IPv6 literal whole', () => {
    expect(hostnameOf('2001:db8::5')).toBe('2001:db8::5');
    expect(hostnameOf('::1')).toBe('::1');
    expect(hostnameOf(hostnameOf('[::1]'))).toBe('::1'); // idempotent
  });

  test('resolveAllowedHosts accepts an unbracketed IPv6 from AGENT_ALLOWED_HOSTS', () => {
    const out = resolveAllowedHosts({ AGENT_ALLOWED_HOSTS: '2001:db8::5' } as NodeJS.ProcessEnv);
    expect(out).toContain('2001:db8::5');
    expect(out).not.toContain('2001');
    expect(isHostAllowed('[2001:db8::5]:6800', out)).toBe(true);
  });

  test('resolveAllowedHosts: loopback defaults + env + extra, hostname-only, deduped', () => {
    const out = resolveAllowedHosts(
      { AGENT_ALLOWED_HOSTS: 'dash.example:8080, localhost' } as NodeJS.ProcessEnv,
      ['http://queue.internal:6790', '127.0.0.1']
    );
    expect(out).toContain('localhost');
    expect(out).toContain('127.0.0.1');
    expect(out).toContain('dash.example');
    // extra passed as full origins is reduced to a hostname too
    expect(out).toContain('queue.internal');
    expect(out.filter((h) => h === 'localhost')).toHaveLength(1);
  });

  test('isHostAllowed: disabled when undefined, otherwise fail-closed and hostname-based', () => {
    expect(isHostAllowed('evil.example', undefined)).toBe(true); // check disabled
    expect(isHostAllowed(null, ['localhost'])).toBe(false);
    expect(isHostAllowed('localhost:6800', ['localhost'])).toBe(true);
    expect(isHostAllowed('evil.example:6800', ['localhost', '127.0.0.1'])).toBe(false);
  });

  test('handler: a rebinding or missing Host is 403; allowlisted loopback passes', async () => {
    const m = new ProcessManager();
    const handle = createFetchHandler(m, {
      allowedOrigins: ALLOWED,
      allowedHosts: ['localhost', '127.0.0.1'],
    });
    const get = (host: string | null) =>
      handle(
        new Request('http://127.0.0.1:6800/control/status', {
          headers: host ? { host } : {},
        })
      );

    // DNS-rebound page: same-origin GET, no Origin, attacker Host → blocked.
    expect((await get('evil.example')).status).toBe(403);
    // Legitimate loopback access still reads.
    expect((await get('localhost:6800')).status).toBe(200);
    expect((await get('127.0.0.1:6800')).status).toBe(200);
    // Once the check is configured, even an unusual no-Host proxy path fails closed.
    expect((await get(null)).status).toBe(403);
  });

  test('handler: without allowedHosts the Host check is a no-op (backward compatible)', async () => {
    const m = new ProcessManager();
    const handle = createFetchHandler(m, { allowedOrigins: ALLOWED });
    const res = await handle(
      new Request('http://127.0.0.1:6800/control/status', {
        headers: { host: 'evil.example' },
      })
    );
    expect(res.status).toBe(200);
  });
});

describe('agent config runtime validation', () => {
  test('invalid JSON shapes return 400 and the config update is atomic', async () => {
    const m = new ProcessManager();
    const before = m.getConfig();
    const handle = createFetchHandler(m, { allowedOrigins: ALLOWED });
    const invalid = [
      { command: '' },
      { httpPort: '7000' },
      { tcpPort: 1.25 },
      { dataPath: 42 },
      { extraEnv: { OK: 'yes', BAD: false } },
      { unknown: 'field' },
      { httpPort: 7000, tcpPort: 70_000 },
    ];

    for (const body of invalid) {
      const res = await handle(
        put('http://127.0.0.1:6800/control/config', body, 'http://localhost:5273')
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
      expect(m.getConfig()).toEqual(before);
    }

    const invalidShape = await handle(
      put('http://127.0.0.1:6800/control/config', ['not', 'an', 'object'], null)
    );
    expect(invalidShape.status).toBe(400);
    expect(m.getConfig()).toEqual(before);

    const malformed = await handle(
      new Request('http://127.0.0.1:6800/control/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: '{"httpPort":',
      })
    );
    expect(malformed.status).toBe(400);
    expect(m.getConfig()).toEqual(before);
  });

  test('a complete valid patch is accepted', async () => {
    const m = new ProcessManager();
    const handle = createFetchHandler(m, { allowedOrigins: ALLOWED });
    const res = await handle(
      put(
        'http://127.0.0.1:6800/control/config',
        {
          command: 'bunqueue start',
          httpPort: 7100,
          tcpPort: 7101,
          dataPath: '',
          extraEnv: { LOG_LEVEL: 'debug' },
        },
        'http://localhost:5273'
      )
    );
    expect(res.status).toBe(200);
    expect(m.getConfig()).toMatchObject({
      httpPort: 7100,
      tcpPort: 7101,
      dataPath: '',
      extraEnv: { LOG_LEVEL: 'debug' },
    });
  });
});

describe('agent managed-server health probe', () => {
  test('reports healthy only when a 2xx JSON body has ok exactly true', async () => {
    const m = new ProcessManager();
    m.setConfig({ command: 'sleep 30' });
    await m.start();
    const handle = createFetchHandler(m, { allowedOrigins: ALLOWED });
    const realFetch = globalThis.fetch;
    try {
      for (const payload of [{}, { ok: false }, { ok: 'true' }, { ok: 1 }, null]) {
        globalThis.fetch = (() => Promise.resolve(Response.json(payload))) as typeof fetch;
        const res = await handle(new Request('http://127.0.0.1:6800/control/status'));
        expect(res.status).toBe(200);
        expect(((await res.json()) as { healthy: boolean }).healthy).toBe(false);
      }

      globalThis.fetch = (() =>
        Promise.resolve(Response.json({ ok: true, version: '1.2.3' }))) as typeof fetch;
      const healthy = await handle(new Request('http://127.0.0.1:6800/control/status'));
      expect(await healthy.json()).toMatchObject({ healthy: true, version: '1.2.3' });
    } finally {
      globalThis.fetch = realFetch;
      await m.stop();
    }
  });
});
