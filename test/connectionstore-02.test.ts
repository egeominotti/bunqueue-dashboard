import {
  afterEach,
  beforeEach,
  describe,
  expect,
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
});
