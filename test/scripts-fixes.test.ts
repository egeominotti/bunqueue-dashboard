import {
  ALLOWED,
  describe,
  expect,
  handler,
  isHostAllowed,
  isLoopbackBind,
  isLoopbackHost,
  isRemoteBridgeRequest,
  it,
  remoteBridgeRequiresToken,
  remoteControlEnabled,
  resolveServeAllowedHosts,
  within,
} from './scripts-fixes.helpers';

describe('serve.ts control-plane exposure', () => {
  it('allows the bridge on a loopback bind', () => {
    expect(isLoopbackBind('127.0.0.1')).toBe(true);
    expect(isLoopbackBind('127.0.0.42')).toBe(true);
    expect(isLoopbackBind('::1')).toBe(true);
    expect(isLoopbackBind('0.0.0.0')).toBe(false);
    expect(remoteControlEnabled(false, {})).toBe(true);
  });

  it('recognizes deployment signals that make a loopback bridge remote', () => {
    expect(remoteBridgeRequiresToken(true, {})).toBe(false);
    expect(remoteBridgeRequiresToken(false, {})).toBe(true);
    expect(remoteBridgeRequiresToken(true, { TRUST_PROXY: '1' })).toBe(true);
    expect(remoteBridgeRequiresToken(true, { AGENT_ALLOWED_HOSTS: 'dashboard.example.com' })).toBe(
      true
    );
    expect(
      remoteBridgeRequiresToken(true, {
        AGENT_ALLOWED_ORIGINS: 'https://dashboard.example.com',
      })
    ).toBe(true);
    expect(
      remoteBridgeRequiresToken(true, {
        AGENT_ALLOWED_HOSTS: 'localhost,127.0.0.2',
        AGENT_ALLOWED_ORIGINS: 'http://localhost:8080',
      })
    ).toBe(false);
  });

  it('treats public Hosts and forwarding metadata as remote without trusting their values', () => {
    expect(isLoopbackHost('localhost:8080')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isRemoteBridgeRequest(new Request('http://localhost:8080/agent'))).toBe(false);
    expect(isRemoteBridgeRequest(new Request('http://dashboard.example.com/agent'))).toBe(true);
    expect(
      isRemoteBridgeRequest(
        new Request('http://localhost:8080/agent', {
          headers: { Origin: 'https://dashboard.example.com' },
        })
      )
    ).toBe(true);
    expect(
      isRemoteBridgeRequest(
        new Request('http://localhost:8080/agent', {
          headers: { 'X-Forwarded-Host': 'dashboard.example.com' },
        })
      )
    ).toBe(true);
    expect(isRemoteBridgeRequest(new Request('http://localhost:8080/agent'), true)).toBe(true);
  });

  it('requires wildcard LAN/container Hosts to be listed explicitly', async () => {
    const defaults = resolveServeAllowedHosts('0.0.0.0', ALLOWED, {});
    expect(isHostAllowed('192.168.1.50:8080', defaults)).toBe(false);
    expect(isHostAllowed('dashboard:8080', defaults)).toBe(false);
    expect(
      (
        await handler({ allowedHosts: defaults })(
          new Request('http://192.168.1.50:8080/', {
            headers: { Host: '192.168.1.50:8080' },
          })
        )
      ).status
    ).toBe(403);

    const listed = resolveServeAllowedHosts('0.0.0.0', ALLOWED, {
      AGENT_ALLOWED_HOSTS: '192.168.1.50,dashboard',
    });
    expect(isHostAllowed('192.168.1.50:8080', listed)).toBe(true);
    expect(isHostAllowed('dashboard:8080', listed)).toBe(true);
    expect(
      (
        await handler({ allowedHosts: listed })(
          new Request('http://192.168.1.50:8080/', {
            headers: { Host: '192.168.1.50:8080' },
          })
        )
      ).status
    ).toBe(200);

    const concrete = resolveServeAllowedHosts('192.168.1.50', ALLOWED, {});
    expect(isHostAllowed('192.168.1.50:8080', concrete)).toBe(true);
    const originListed = resolveServeAllowedHosts(
      '0.0.0.0',
      [...ALLOWED, 'http://dashboard.lan:8080'],
      {}
    );
    expect(isHostAllowed('dashboard.lan:8080', originListed)).toBe(true);
  });

  it('requires a non-empty token for remote control on a non-loopback bind', () => {
    expect(remoteControlEnabled(true, {})).toBe(false);
    expect(remoteControlEnabled(true, { AGENT_TOKEN: 's3cret' })).toBe(true);
    expect(remoteControlEnabled(true, { AGENT_TOKEN: '   ' })).toBe(false);
    // The former unauthenticated escape hatch must stay closed.
    expect(remoteControlEnabled(true, { AGENT_ALLOW_REMOTE_CONTROL: '1' })).toBe(false);
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

  it('propagates a caller abort through the in-process agent bridge', async () => {
    const controller = new AbortController();
    let innerSignal: AbortSignal | undefined;
    const abortAwareAgent = (req: Request) => {
      innerSignal = req.signal;
      return new Promise<Response>((resolve) => {
        req.signal.addEventListener(
          'abort',
          () => resolve(Response.json({ ok: false, aborted: true })),
          { once: true }
        );
      });
    };
    const pending = handler({
      agentHandle: abortAwareAgent,
      remoteAgentHandle: abortAwareAgent,
    })(
      new Request('http://localhost:8080/agent/db/tables/jobs/export', {
        signal: controller.signal,
      })
    );

    await Promise.resolve();
    expect(innerSignal?.aborted).toBe(false);
    controller.abort(new Error('browser disconnected'));
    const res = await within(pending);
    expect(innerSignal?.aborted).toBe(true);
    expect((await res.json()).aborted).toBe(true);
  });
});
