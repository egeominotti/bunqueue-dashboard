import {
  afterEach,
  beforeEach,
  bq,
  describe,
  expect,
  getBaseUrl,
  realFetch,
  STORAGE_KEY,
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
});
