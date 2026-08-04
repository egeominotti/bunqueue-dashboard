import {
  act,
  CopilotBoundary,
  createElement,
  createModel,
  createRoot,
  describe,
  ensureDom,
  expect,
  normalizeCustomProviderBaseURL,
  providerById,
  resolveCompatibleProviderBaseURL,
  test,
} from './copilot-fixes.helpers';

describe('copilot lazy-chunk failure containment', () => {
  test('a panel that fails to load is caught inside the drawer, not by the app shell', () => {
    ensureDom();
    const Boom = () => {
      throw new Error('Failed to fetch dynamically imported module: /assets/CopilotPanel-abc.js');
    };
    const host = document.createElement('div');
    const root = createRoot(host, {
      // Keep React's expected uncaught/recoverable logging out of the test output.
      onUncaughtError: () => {},
      onCaughtError: () => {},
    });
    let closed = false;

    expect(() =>
      act(() =>
        root.render(
          createElement(
            CopilotBoundary,
            {
              onClose: () => {
                closed = true;
              },
            },
            createElement(Boom)
          )
        )
      )
    ).not.toThrow();

    expect(host.textContent).toContain('Copilot failed to load');
    const button = host.querySelector('button');
    act(() => button?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    expect(closed).toBe(true);
    act(() => root.unmount());
  });
});

describe('copilot provider resolution', () => {
  test('an unknown provider id is refused instead of receiving the key at a stale base URL', async () => {
    await expect(
      createModel({
        provider: 'anthropic-v2',
        baseURL: 'https://collect.evil.example/v1',
        apiKey: 'sk-SECRET',
        model: 'claude-opus-4-8',
      })
    ).rejects.toThrow(/Unknown Copilot provider/);
  });

  test('a fixed provider ignores a hostile persisted base URL in the actual model transport', async () => {
    const model = await createModel({
      provider: 'openrouter',
      baseURL: 'https://collect.evil.example/v1',
      apiKey: 'sk-SECRET',
      model: 'openai/gpt-5.1',
    });
    const transport = model as unknown as {
      config: { url: (input: { path: string }) => string };
    };
    expect(transport.config.url({ path: '/chat/completions' })).toBe(
      'https://openrouter.ai/api/v1/chat/completions'
    );
    expect(transport.config.url({ path: '/chat/completions' })).not.toContain(
      'collect.evil.example'
    );

    const def = providerById('zai');
    if (!def) throw new Error('zai provider missing');
    expect(
      resolveCompatibleProviderBaseURL(
        {
          provider: 'zai',
          baseURL: 'https://collect.evil.example/v1',
          apiKey: 'zai-SECRET',
          model: 'glm-4.6',
        },
        def
      )
    ).toBe('https://api.z.ai/api/paas/v4');
  });

  test('custom endpoints require canonical http(s) URLs without credentials/query/fragment', async () => {
    expect(normalizeCustomProviderBaseURL(' https://models.example/v1/// ')).toBe(
      'https://models.example/v1'
    );
    expect(normalizeCustomProviderBaseURL('http://127.0.0.1:11434/v1')).toBe(
      'http://127.0.0.1:11434/v1'
    );

    for (const invalid of [
      '',
      '/v1',
      'ftp://models.example/v1',
      'https://user:pass@models.example/v1',
      'https://models.example/v1?tenant=a',
      'https://models.example/v1#fragment',
      'https:\\models.example\\v1',
    ]) {
      expect(normalizeCustomProviderBaseURL(invalid)).toBeNull();
    }

    await expect(
      createModel({
        provider: 'custom',
        baseURL: 'https://user:pass@collect.evil.example/v1',
        apiKey: 'sk-SECRET',
        model: 'custom-model',
      })
    ).rejects.toThrow(/Custom provider base URL/);
  });
});
