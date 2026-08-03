import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  CONNECTION_STORAGE_KEY,
  getAgentAuthHeaders,
  getAuthHeaders,
  getBaseUrl,
  isValidBaseUrl,
  normalizeBaseUrl,
  persistedConnectionState,
  resolveDefaultBaseUrl,
  sanitizedPersistedConnectionState,
  useConnectionStore,
} from '../src/components/dashboard/stores/connectionStore';
import { api } from '../src/lib/api';
import { bq } from '../src/lib/bq';

const realFetch = globalThis.fetch;
const STORAGE_KEY = CONNECTION_STORAGE_KEY;

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

  test('rehydration rewrites versioned and unversioned raw blobs without legacy authority or tokens', async () => {
    for (const version of [1, 2, undefined]) {
      useConnectionStore.setState({
        baseUrl: 'https://current.example',
        token: 'current-server-token',
        agentToken: 'current-agent-token',
        refreshMs: 3000,
      });
      const legacyState = {
        baseUrl: '//legacy.example',
        refreshMs: 1,
        token: 'legacy-server-token',
        agentToken: 'legacy-agent-token',
      };
      globalThis.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(
          version === undefined ? { state: legacyState } : { state: legacyState, version }
        )
      );

      await useConnectionStore.persist.rehydrate();
      const state = useConnectionStore.getState();
      const label = version === undefined ? 'unversioned' : `version ${version}`;
      expect(state.baseUrl, label).toBe('/api');
      expect(state.refreshMs, label).toBe(500);
      expect(state.token, label).toBe('');
      expect(state.agentToken, label).toBe('');

      const raw = globalThis.localStorage.getItem(STORAGE_KEY);
      expect(raw, label).not.toBeNull();
      expect(JSON.parse(raw as string), label).toEqual({
        state: { baseUrl: '/api', refreshMs: 500 },
        version: 2,
      });
      expect(raw, label).not.toContain('legacy.example');
      expect(raw, label).not.toContain('token');
    }
  });

  test('a quota failure deletes the legacy secret blob and hydrates only scrubbed fields', async () => {
    const storage = globalThis.localStorage;
    useConnectionStore.setState({
      baseUrl: 'https://current.example',
      token: 'current-server-token',
      agentToken: 'current-agent-token',
      refreshMs: 3000,
    });
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        state: {
          baseUrl: 'https://queue.example.com/api/',
          refreshMs: 2000,
          token: 'legacy-server-token',
          agentToken: 'legacy-agent-token',
        },
        version: 2,
      })
    );

    const setDescriptor = Object.getOwnPropertyDescriptor(storage, 'setItem');
    const removeDescriptor = Object.getOwnPropertyDescriptor(storage, 'removeItem');
    const removeItem = storage.removeItem.bind(storage);
    const removed: string[] = [];
    Object.defineProperty(storage, 'setItem', {
      configurable: true,
      value: () => {
        const error = new Error('storage quota reached');
        error.name = 'QuotaExceededError';
        throw error;
      },
    });
    Object.defineProperty(storage, 'removeItem', {
      configurable: true,
      value: (name: string) => {
        removed.push(name);
        removeItem(name);
      },
    });

    try {
      await useConnectionStore.persist.rehydrate();
      expect(removed).toEqual([STORAGE_KEY]);
      expect(storage.getItem(STORAGE_KEY)).toBeNull();
      expect(useConnectionStore.getState()).toMatchObject({
        baseUrl: 'https://queue.example.com/api',
        refreshMs: 2000,
        token: '',
        agentToken: '',
      });
    } finally {
      if (setDescriptor) Object.defineProperty(storage, 'setItem', setDescriptor);
      else Reflect.deleteProperty(storage, 'setItem');
      if (removeDescriptor) Object.defineProperty(storage, 'removeItem', removeDescriptor);
      else Reflect.deleteProperty(storage, 'removeItem');
    }
  });

  test('a quota failure keeps one atomic in-memory commit and reports session-only durability', () => {
    const storage = globalThis.localStorage;
    const original = Object.getOwnPropertyDescriptor(storage, 'setItem');
    const snapshots: Array<[string, string, string]> = [];
    const unsubscribe = useConnectionStore.subscribe((state) => {
      snapshots.push([state.baseUrl, state.token, state.agentToken]);
    });
    Object.defineProperty(storage, 'setItem', {
      configurable: true,
      value: () => {
        const error = new Error('storage quota reached');
        error.name = 'QuotaExceededError';
        throw error;
      },
    });
    try {
      const outcome = useConnectionStore.getState().saveConnection({
        baseUrl: 'https://queue.example.com/api/',
        token: ' server-token ',
        agentToken: ' agent-token ',
      });
      expect(outcome.persisted).toBe(false);
      expect(outcome.error).toContain('QuotaExceededError');
      expect(useConnectionStore.getState()).toMatchObject({
        baseUrl: 'https://queue.example.com/api',
        token: 'server-token',
        agentToken: 'agent-token',
      });
      expect(snapshots).toEqual([['https://queue.example.com/api', 'server-token', 'agent-token']]);
      expect(() => useConnectionStore.getState().setRefreshMs(5000)).not.toThrow();
    } finally {
      unsubscribe();
      if (original) Object.defineProperty(storage, 'setItem', original);
      else Reflect.deleteProperty(storage, 'setItem');
    }

    const recovered = useConnectionStore.getState().saveConnection({
      baseUrl: '/api',
      token: '',
      agentToken: '',
    });
    expect(recovered).toEqual({ persisted: true });
  });

  test('a localStorage SecurityError never escapes a connection setter', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        const error = new Error('storage access denied');
        error.name = 'SecurityError';
        throw error;
      },
    });
    try {
      const outcome = useConnectionStore.getState().saveConnection({
        baseUrl: '/secure-api',
        token: 'server-token',
        agentToken: 'agent-token',
      });
      expect(outcome.persisted).toBe(false);
      expect(outcome.error).toContain('SecurityError');
      expect(useConnectionStore.getState()).toMatchObject({
        baseUrl: '/secure-api',
        token: 'server-token',
        agentToken: 'agent-token',
      });
      expect(() => useConnectionStore.getState().setBaseUrl('/next-api')).not.toThrow();
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
      else Reflect.deleteProperty(globalThis, 'localStorage');
    }
  });

  test('missing localStorage reports session-only durability without breaking SSR-style reads', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Reflect.deleteProperty(globalThis, 'localStorage');
    try {
      await useConnectionStore.persist.rehydrate();
      const outcome = useConnectionStore.getState().saveConnection({
        baseUrl: '/memory-only-api',
        token: 'server-token',
        agentToken: 'agent-token',
      });
      expect(outcome.persisted).toBe(false);
      expect(outcome.error).toContain('localStorage is unavailable');
      expect(useConnectionStore.getState()).toMatchObject({
        baseUrl: '/memory-only-api',
        token: 'server-token',
        agentToken: 'agent-token',
      });
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
    }
  });

  test('the setter and transport fail closed before attaching a token to a legacy target', async () => {
    useConnectionStore.getState().setBaseUrl('https://safe.example/api///');
    expect(useConnectionStore.getState().baseUrl).toBe('https://safe.example/api');

    useConnectionStore.getState().setBaseUrl('//legacy.example');
    expect(useConnectionStore.getState().baseUrl).toBe('/api');

    // Simulate state injected by an old build or an accidental direct setState.
    // getBaseUrl is the final transport boundary and must still discard it.
    useConnectionStore.setState({ baseUrl: '//legacy.example', token: 'session-secret' });
    expect(getBaseUrl()).toBe('/api');
    let requestUrl = '';
    let requestHeaders = new Headers();
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(input);
      requestHeaders = new Headers(init?.headers);
      return Promise.resolve(Response.json({ ok: true }));
    }) as typeof fetch;

    await bq.stats();
    expect(requestUrl).toBe('/api/stats');
    expect(requestUrl).not.toContain('legacy.example');
    expect(requestHeaders.get('Authorization')).toBe('Bearer session-secret');
  });

  test('the API uses decoded queue segments while the SSE route keeps its raw suffix', async () => {
    useConnectionStore.setState({ baseUrl: 'https://queue.example/api', token: '' });
    const requests: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      requests.push(String(input));
      return Promise.resolve(Response.json({ ok: true }));
    }) as typeof fetch;

    await api.pause('orders:eu.1');
    expect(requests).toEqual(['https://queue.example/api/queues/orders%3Aeu.1/pause']);
    expect(api.eventsUrl('orders:eu.1')).toBe(
      'https://queue.example/api/events/queues/orders:eu.1'
    );
    expect(() => api.pause('.')).toThrow('path traversal segment');
    expect(() => api.eventsUrl('..')).toThrow('path traversal segment');
  });

  test('setters trim bearer tokens and reject a non-finite polling interval', () => {
    useConnectionStore.getState().setToken('  server-token  ');
    useConnectionStore.getState().setAgentToken('  agent-token  ');
    useConnectionStore.getState().setRefreshMs(Number.NaN);
    expect(getAuthHeaders()).toEqual({ Authorization: 'Bearer server-token' });
    expect(getAgentAuthHeaders()).toEqual({ Authorization: 'Bearer agent-token' });
    expect(useConnectionStore.getState().refreshMs).toBe(3000);
  });
});
