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

describe('agent token gate', () => {
  test('loopback policy keeps reads open while a configured token gates mutations', async () => {
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

  test('network policy requires the token for every route, including sensitive reads', async () => {
    const m = new ProcessManager();
    const handle = createFetchHandler(m, {
      allowedOrigins: ALLOWED,
      allowedHosts: ['dash.lan'],
      token: 's3cr3t',
      requireTokenForAll: true,
    });

    for (const path of ['/control/status', '/control/logs', '/control/config', '/db/tables']) {
      const denied = await handle(
        new Request(`http://dash.lan:6800${path}`, {
          headers: { Host: 'dash.lan:6800', Origin: 'http://localhost:5273' },
        })
      );
      expect(denied.status).toBe(401);
    }

    const allowed = await handle(
      new Request('http://dash.lan:6800/control/config', {
        headers: {
          Origin: 'http://localhost:5273',
          Host: 'dash.lan:6800',
          Authorization: 'Bearer s3cr3t',
        },
      })
    );
    expect(allowed.status).toBe(200);

    const rebound = await handle(
      new Request('http://dash.lan:6800/control/config', {
        headers: {
          Host: 'evil.example',
          Authorization: 'Bearer s3cr3t',
        },
      })
    );
    expect(rebound.status).toBe(403);
  });

  test('network policy fails closed when enabled without a configured token', async () => {
    const m = new ProcessManager();
    const handle = createFetchHandler(m, {
      allowedOrigins: ALLOWED,
      requireTokenForAll: true,
    });
    const res = await handle(new Request('http://dash.lan:6800/control/status'));
    expect(res.status).toBe(401);
  });
});
