/**
 * Regression tests for the audited scripts/ findings:
 *   serve.ts — non-loopback control-plane gate, same-origin Origin handling,
 *              /api 502 on an unreachable upstream, `//x:y` path crash;
 *   dev.ts   — a throwing spawn must not orphan already-started children;
 *   check-coverage.ts — a malformed lcov must fail, not pass.
 */
import { describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agentSubUrl,
  createServeHandler,
  isLoopbackBind,
  remoteControlEnabled,
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
    allowedOrigins: ALLOWED,
    agentBridge: true,
    ...over,
  });
}

describe('serve.ts control-plane exposure', () => {
  it('allows the bridge on a loopback bind', () => {
    expect(isLoopbackBind('127.0.0.1')).toBe(true);
    expect(isLoopbackBind('0.0.0.0')).toBe(false);
    expect(remoteControlEnabled(true, {})).toBe(true);
  });

  it('refuses remote control on a non-loopback bind without an explicit opt-in', () => {
    expect(remoteControlEnabled(false, {})).toBe(false);
    expect(remoteControlEnabled(false, { AGENT_TOKEN: 's3cret' })).toBe(true);
    expect(remoteControlEnabled(false, { AGENT_ALLOW_REMOTE_CONTROL: '1' })).toBe(true);
  });

  it('403s the /agent bridge (no process spawn) when it is disabled', async () => {
    const res = await handler({ agentBridge: false })(
      new Request('http://192.168.1.5:8080/agent/control/start', { method: 'POST' })
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('AGENT_TOKEN');
  });

  it('still bridges /agent when enabled', async () => {
    const res = await handler()(new Request('http://localhost:8080/agent/control/status'));
    expect(res.status).toBe(200);
    expect((await res.json()).url).toBe('http://agent.internal/control/status');
  });
});

describe('serve.ts same-origin normalization', () => {
  it('drops a LAN same-origin Origin the agent allowlist cannot know', async () => {
    const res = await handler()(
      new Request('http://192.168.1.5:8080/agent/control/start', {
        method: 'POST',
        headers: { origin: 'http://192.168.1.5:8080' },
        body: '{}',
      })
    );
    const got = (await res.json()) as { origin: string | null; method: string; body: string };
    expect(got.origin).toBeNull(); // would 403 in agent/server.ts otherwise
    expect(got.method).toBe('POST');
    expect(got.body).toBe('{}');
  });

  it('forwards an allowlisted loopback Origin untouched', async () => {
    const res = await handler()(
      new Request('http://localhost:8080/agent/control/start', {
        method: 'POST',
        headers: { origin: 'http://localhost:8080' },
        body: '{}',
      })
    );
    expect((await res.json()).origin).toBe('http://localhost:8080');
  });

  it('keeps a cross-site Origin so the agent can reject it', async () => {
    const res = await handler()(
      new Request('http://localhost:8080/agent/control/start', {
        method: 'POST',
        headers: { origin: 'http://evil.example' },
        body: '{}',
      })
    );
    expect((await res.json()).origin).toBe('http://evil.example');
  });
});

describe('serve.ts /agent path parsing', () => {
  it('does not throw on a path that looks like an authority', () => {
    expect(agentSubUrl('/agent//x:y/z', '').href).toBe('http://agent.internal//x:y/z');
    expect(agentSubUrl('/agent', '').href).toBe('http://agent.internal/');
    expect(agentSubUrl('/agent/db/tables', '?limit=5').href).toBe(
      'http://agent.internal/db/tables?limit=5'
    );
  });

  it('answers GET /agent//x:y/z instead of crashing the handler', async () => {
    const res = await handler()(new Request('http://localhost:8080/agent//x:y/z'));
    expect(res.status).toBe(200);
    expect((await res.json()).url).toBe('http://agent.internal//x:y/z');
  });
});

describe('serve.ts /api proxy', () => {
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

  it('403s a cross-site request to the admin API proxy', async () => {
    const res = await handler()(
      new Request('http://localhost:8080/api/queues/x/pause', {
        method: 'POST',
        headers: { origin: 'http://evil.example' },
      })
    );
    expect(res.status).toBe(403);
  });

  it('admits a mutation from the served host over https (TLS-terminating proxy)', async () => {
    // The binary only ever speaks plain http, so behind a reverse proxy the
    // browser's Origin is https:// while req.url is http://. Comparing full
    // origins 403s every pause/retry/add-job on a proxied deployment while
    // read-only GETs (no Origin) keep working — healthy-looking, broken on click.
    const res = await handler({ api: 'http://127.0.0.1:1' })(
      new Request('http://dash.example.com/api/queues/x/pause', {
        method: 'POST',
        headers: { origin: 'https://dash.example.com' },
      })
    );
    expect(res.status).toBe(502); // passed the gate; only the upstream is down
  });

  it('honours x-forwarded-host when the proxy rewrites Host and TRUST_PROXY is set', async () => {
    const res = await handler({ api: 'http://127.0.0.1:1', trustProxy: true })(
      new Request('http://internal-backend:8080/api/queues/x/pause', {
        method: 'POST',
        headers: {
          origin: 'https://dash.example.com',
          'x-forwarded-host': 'dash.example.com',
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
    const res = await handler({ api: 'http://127.0.0.1:1', trustProxy: true })(
      new Request('http://internal-backend:8080/api/queues/x/pause', {
        method: 'POST',
        headers: { origin: 'https://dash.example.com', 'x-forwarded-host': 'Dash.Example.com' },
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
});

describe('dev.ts spawn failure', () => {
  it('kills already-spawned children when a later spawn throws', async () => {
    const killed: string[] = [];
    const realSpawn = Bun.spawn;
    const realExit = process.exit;
    let calls = 0;
    // @ts-expect-error — test double for Bun.spawn
    Bun.spawn = mock(() => {
      calls += 1;
      if (calls === 2) throw new Error('spawn ENOENT');
      return {
        kill: (sig?: string) => killed.push(String(sig ?? 'SIGTERM')),
        exited: Promise.resolve(0),
        exitCode: 0,
        signalCode: null,
      };
    });
    let code: number | undefined;
    // @ts-expect-error — shutdown() ends the process; capture instead.
    process.exit = (c?: number) => {
      code = c;
      throw new Error('__exit__');
    };
    try {
      const { spawnServices } = await import('../scripts/dev');
      await spawnServices().catch((e: Error) => {
        if (e.message !== '__exit__') throw e;
      });
    } finally {
      Bun.spawn = realSpawn;
      process.exit = realExit;
    }
    expect(calls).toBe(2);
    expect(killed.length).toBeGreaterThan(0); // the agent child was torn down
    expect(code).toBe(1);
  });
});

describe('check-coverage.ts', () => {
  const run = async (lcov: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'lcov-'));
    const file = join(dir, 'lcov.info');
    writeFileSync(file, lcov);
    const proc = Bun.spawn(['bun', join(import.meta.dir, '..', 'scripts', 'check-coverage.ts')], {
      env: { ...process.env, LCOV_PATH: file },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return await proc.exited;
  };

  it('fails on a malformed lcov instead of passing with NaN', async () => {
    expect(await run('SF:a.ts\nLF:oops\nLH:1\nFNF:2\nFNH:2\nend_of_record\n')).toBe(1);
  });

  it('fails on an empty lcov', async () => {
    expect(await run('')).toBe(1);
  });

  it('passes a well-formed report above the floor', async () => {
    expect(await run('SF:a.ts\nLF:100\nLH:99\nFNF:10\nFNH:10\nend_of_record\n')).toBe(0);
  });
});
