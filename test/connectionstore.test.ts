import {
  afterEach,
  beforeEach,
  describe,
  expect,
  getAgentAuthHeaders,
  getAuthHeaders,
  isValidBaseUrl,
  normalizeBaseUrl,
  persistedConnectionState,
  realFetch,
  resolveDefaultBaseUrl,
  STORAGE_KEY,
  sanitizedPersistedConnectionState,
  test,
  useConnectionStore,
} from './connectionstore.helpers';

describe('connectionStore security boundary', () => {
  beforeEach(() => {
    globalThis.fetch = realFetch;
    useConnectionStore.setState({ baseUrl: '/api', token: '', agentToken: '', refreshMs: 3000 });
    globalThis.localStorage.removeItem(STORAGE_KEY);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    useConnectionStore.setState({ baseUrl: '/api', token: '', agentToken: '', refreshMs: 3000 });
    globalThis.localStorage.removeItem(STORAGE_KEY);
  });

  // Security property: neither the server bearer token nor the agent token may
  // be written to localStorage — the persisted projection keeps only baseUrl +
  // refreshMs (same secrets-at-rest policy as the S3 keys).
  test('persisted projection excludes both tokens', () => {
    const persisted = persistedConnectionState({
      baseUrl: '/api',
      token: 'server-secret',
      agentToken: 'agent-secret',
      refreshMs: 3000,
      saveConnection: () => ({ persisted: true }),
      setBaseUrl: () => {},
      setToken: () => {},
      setAgentToken: () => {},
      setRefreshMs: () => {},
    });
    expect(persisted).toEqual({ baseUrl: '/api', refreshMs: 3000 });
    const serialized = JSON.stringify(persisted);
    expect(serialized).not.toContain('server-secret');
    expect(serialized).not.toContain('agent-secret');
  });

  test('getAgentAuthHeaders sends the agent token independently of the server token', () => {
    expect(getAgentAuthHeaders()).toEqual({});

    useConnectionStore.getState().setAgentToken('agent-tok');
    expect(getAgentAuthHeaders()).toEqual({ Authorization: 'Bearer agent-tok' });
    // The server-scoped headers must NOT pick up the agent token.
    expect(getAuthHeaders()).toEqual({});

    useConnectionStore.getState().setToken('server-tok');
    expect(getAuthHeaders()).toEqual({ Authorization: 'Bearer server-tok' });
    expect(getAgentAuthHeaders()).toEqual({ Authorization: 'Bearer agent-tok' });
  });

  test('untrusted persisted values are normalized and cannot restore secrets', () => {
    expect(
      sanitizedPersistedConnectionState({
        baseUrl: 42,
        refreshMs: Number.NaN,
        token: 'old-server-secret',
        agentToken: 'old-agent-secret',
      })
    ).toEqual({ baseUrl: '/api', refreshMs: 3000 });
    expect(
      sanitizedPersistedConnectionState({ baseUrl: ' https://queue.example.com/// ', refreshMs: 1 })
    ).toEqual({ baseUrl: 'https://queue.example.com', refreshMs: 500 });
  });

  test('one parser canonicalizes safe path prefixes and credential-free HTTP(S) URLs', () => {
    expect(normalizeBaseUrl('/api')).toBe('/api');
    expect(normalizeBaseUrl(' /bunqueue/api/// ')).toBe('/bunqueue/api');
    expect(normalizeBaseUrl('http://localhost:6790/')).toBe('http://localhost:6790');
    expect(normalizeBaseUrl(' HTTPS://Queue.Example.com:443/api/// ')).toBe(
      'https://queue.example.com/api'
    );
    expect(isValidBaseUrl('https://[::1]:6790/api')).toBe(true);
  });

  test('rejects protocol-relative, non-HTTP, credential, query, fragment, and ambiguous paths', () => {
    const unsafe = [
      '',
      '/',
      '//legacy.example',
      '///legacy.example',
      '/\\legacy.example',
      '/%2e%2e//legacy.example',
      '/api?target=legacy.example',
      '/api#legacy',
      'http:legacy.example',
      'https:\\legacy.example',
      'ftp://legacy.example',
      'javascript:alert(1)',
      'data:text/plain,hello',
      'https://@legacy.example',
      'https://user@legacy.example',
      'https://user:secret@legacy.example',
      'https://legacy.example?',
      'https://legacy.example?token=1',
      'https://legacy.example#',
      'https://legacy.example#token',
      'https://legacy.example/api/..//other-authority-shape',
    ];
    for (const value of unsafe) {
      expect(normalizeBaseUrl(value), value).toBeNull();
      expect(isValidBaseUrl(value), value).toBe(false);
    }
  });

  test('an unsafe build-time or persisted default falls back without preserving its authority', () => {
    expect(resolveDefaultBaseUrl('//legacy.example')).toBe('/api');
    expect(resolveDefaultBaseUrl('javascript://legacy.example')).toBe('/api');
    expect(resolveDefaultBaseUrl('https://safe.example/api/')).toBe('https://safe.example/api');

    for (const baseUrl of [
      '//legacy.example',
      'https://user:secret@legacy.example',
      'https://legacy.example?redirect=safe',
      'https://legacy.example#safe',
    ]) {
      expect(sanitizedPersistedConnectionState({ baseUrl, refreshMs: 3000 })).toEqual({
        baseUrl: '/api',
        refreshMs: 3000,
      });
    }
  });
});
