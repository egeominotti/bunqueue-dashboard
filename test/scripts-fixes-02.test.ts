import { describe, expect, handler, it, realAgentBridge } from './scripts-fixes.helpers';

describe('serve.ts control-plane exposure', () => {
  it('fails a public or proxied bridge closed when no AGENT_TOKEN is configured', async () => {
    for (const req of [
      new Request('http://dashboard.example.com/agent/control/status'),
      new Request('http://localhost:8080/agent/control/status', {
        headers: { 'X-Forwarded-Host': 'dashboard.example.com' },
      }),
    ]) {
      const res = await handler()(req);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toContain('AGENT_TOKEN');
    }
  });
});

describe('serve.ts proxied agent bridge authentication', () => {
  const PUBLIC_HOST = { Host: 'dashboard.example.com' };

  it('requires AGENT_TOKEN on every sensitive read and mutation with a preserved public Host', async () => {
    const { handle } = realAgentBridge({ token: 's3cret', remoteBridgePolicy: true });
    for (const path of [
      '/agent/control/status',
      '/agent/control/logs',
      '/agent/control/config',
      '/agent/db/tables',
      '/agent/control/start',
    ]) {
      const mutation = path.endsWith('/start');
      const res = await handle(
        new Request(`http://dashboard.example.com${path}`, {
          method: mutation ? 'POST' : 'GET',
          headers: PUBLIC_HOST,
        })
      );
      expect(res.status).toBe(401);
    }

    const allowed = await handle(
      new Request('http://dashboard.example.com/agent/control/config', {
        headers: { ...PUBLIC_HOST, Authorization: 'Bearer s3cret' },
      })
    );
    expect(allowed.status).toBe(200);
  });

  it('fails every remote route closed when the deployment has no AGENT_TOKEN', async () => {
    const { handle } = realAgentBridge({ remoteBridgePolicy: true });
    for (const [path, method] of [
      ['/agent/control/status', 'GET'],
      ['/agent/control/logs', 'GET'],
      ['/agent/control/config', 'GET'],
      ['/agent/db/tables', 'GET'],
      ['/agent/control/start', 'POST'],
    ] as const) {
      const res = await handle(
        new Request(`http://dashboard.example.com${path}`, { method, headers: PUBLIC_HOST })
      );
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toContain('AGENT_TOKEN');
    }
  });

  it('uses remote all-route auth when a trusted proxy rewrites Host to loopback', async () => {
    const { handle } = realAgentBridge({
      token: 's3cret',
      remoteBridgePolicy: true,
      trustProxy: true,
    });
    const headers = {
      Host: '127.0.0.1:8080',
      Origin: 'https://dashboard.example.com',
      'X-Forwarded-Host': 'dashboard.example.com',
    };
    const denied = await handle(
      new Request('http://127.0.0.1:8080/agent/control/config', { headers })
    );
    expect(denied.status).toBe(401);

    const allowed = await handle(
      new Request('http://127.0.0.1:8080/agent/control/config', {
        headers: { ...headers, Authorization: 'Bearer s3cret' },
      })
    );
    expect(allowed.status).toBe(200);
  });

  it('keeps the truly local bridge zero-config', async () => {
    const { handle, manager } = realAgentBridge();
    const read = await handle(
      new Request('http://localhost:8080/agent/control/config', {
        headers: { Host: 'localhost:8080' },
      })
    );
    expect(read.status).toBe(200);

    const write = await handle(
      new Request('http://localhost:8080/agent/control/config', {
        method: 'PUT',
        headers: { Host: 'localhost:8080', 'Content-Type': 'application/json' },
        body: JSON.stringify({ httpPort: 8123 }),
      })
    );
    expect(write.status).toBe(200);
    expect(manager.getConfig().httpPort).toBe(8123);
  });
});

describe('serve.ts same-origin normalization', () => {
  it('drops a LAN same-origin Origin the agent allowlist cannot know', async () => {
    const res = await handler({ agentTokenConfigured: true })(
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
    const res = await handler({ agentTokenConfigured: true })(
      new Request('http://localhost:8080/agent/control/start', {
        method: 'POST',
        headers: { origin: 'http://evil.example' },
        body: '{}',
      })
    );
    expect((await res.json()).origin).toBe('http://evil.example');
  });
});
