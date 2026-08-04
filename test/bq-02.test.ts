import {
  bq,
  describe,
  expect,
  fetchHarness,
  headerOf,
  installTestHooks,
  json,
  lastCall,
  resolveAgentBase,
  SAFE_AGENT_BASE,
  test,
  useConnectionStore,
} from './bq.helpers';

installTestHooks();

describe('bq auth scoping', () => {
  test('server token goes to server calls only; agent token to agent calls only', async () => {
    useConnectionStore.getState().setToken('srv-tok');
    useConnectionStore.getState().setAgentToken('agent-tok');

    await bq.stats();
    expect(headerOf(lastCall().init, 'Authorization')).toBe('Bearer srv-tok');

    await bq.control.status();
    const agentCall = lastCall();
    expect(agentCall.url).toBe('http://localhost:6800/control/status');
    expect(headerOf(agentCall.init, 'Authorization')).toBe('Bearer agent-tok');
  });

  test('a 401 dispatches auth:required scoped to the backend that rejected', async () => {
    // Swap in a bare EventTarget as `window`, restoring whatever was there
    // before (test files share one global scope — another file may have
    // installed a happy-dom window that must survive this test).
    const prev = (globalThis as { window?: unknown }).window;
    const target = new EventTarget();
    (globalThis as { window?: unknown }).window = target;
    try {
      const details: Array<{ scope: string; target: string }> = [];
      target.addEventListener('auth:required', (e) => {
        details.push((e as CustomEvent<{ scope: string; target: string }>).detail);
      });
      fetchHarness.responder = () => json({ error: 'unauthorized' }, 401);
      await expect(bq.stats()).rejects.toThrow('unauthorized');
      await expect(bq.control.status()).rejects.toThrow('unauthorized');
      expect(details).toEqual([
        { scope: 'server', auth: undefined, target: 'http://srv' },
        { scope: 'agent', auth: undefined, target: bq.agentBase },
      ]);
    } finally {
      if (prev === undefined) {
        delete (globalThis as { window?: unknown }).window;
      } else {
        (globalThis as { window?: unknown }).window = prev;
      }
    }
  });

  test('agent base resolution rejects unsafe runtime/build values before bearer use', () => {
    expect(resolveAgentBase('/agent///', 'https://build.example/agent')).toBe('/agent');
    expect(resolveAgentBase('//runtime-attacker.example', 'https://build.example/agent/')).toBe(
      'https://build.example/agent'
    );
    for (const unsafe of [
      '//attacker.example',
      'https://user:secret@attacker.example',
      'https://attacker.example/agent?token=1',
      'https://attacker.example/agent#token',
      'file:///tmp/socket',
      42,
      { toString: () => '/agent' },
    ]) {
      expect(resolveAgentBase(unsafe, unsafe), String(unsafe)).toBe(SAFE_AGENT_BASE);
    }
  });

  test('agent transport uses its immutable validated snapshot after runtime-global mutation', async () => {
    const runtime = globalThis as { __BUNQUEUE_AGENT_URL__?: unknown };
    const previous = runtime.__BUNQUEUE_AGENT_URL__;
    const snapshot = bq.agentBase;
    try {
      runtime.__BUNQUEUE_AGENT_URL__ = '//attacker.example';
      useConnectionStore.getState().setAgentToken('agent-secret');
      await bq.control.status();
      expect(lastCall().url).toBe(`${snapshot}/control/status`);
      expect(lastCall().url).not.toContain('attacker.example');
      expect(headerOf(lastCall().init, 'Authorization')).toBe('Bearer agent-secret');
      expect(bq.agentBase).toBe(snapshot);
      const descriptor = Object.getOwnPropertyDescriptor(bq, 'agentBase');
      expect(descriptor?.set).toBeUndefined();
      expect(descriptor?.configurable).toBe(false);
    } finally {
      if (previous === undefined) delete runtime.__BUNQUEUE_AGENT_URL__;
      else runtime.__BUNQUEUE_AGENT_URL__ = previous;
    }
  });

  test('a hostile runtime present before fresh module init never receives the agent bearer', async () => {
    const runtime = globalThis as { __BUNQUEUE_AGENT_URL__?: unknown };
    const previous = runtime.__BUNQUEUE_AGENT_URL__;
    try {
      runtime.__BUNQUEUE_AGENT_URL__ = '//attacker.example';
      const isolated = await import('../src/lib/bq.ts?hostile-agent-runtime-before-init');
      expect(isolated.bq).not.toBe(bq);
      expect(isolated.bq.agentBase).not.toContain('attacker.example');

      useConnectionStore.getState().setAgentToken('pre-init-agent-secret');
      await isolated.bq.control.status();
      expect(lastCall().url).toBe(`${isolated.bq.agentBase}/control/status`);
      expect(lastCall().url).not.toContain('attacker.example');
      expect(headerOf(lastCall().init, 'Authorization')).toBe('Bearer pre-init-agent-secret');
    } finally {
      if (previous === undefined) delete runtime.__BUNQUEUE_AGENT_URL__;
      else runtime.__BUNQUEUE_AGENT_URL__ = previous;
    }
  });
});
