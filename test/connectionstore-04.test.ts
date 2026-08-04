import {
  afterEach,
  api,
  beforeEach,
  describe,
  expect,
  getAgentAuthHeaders,
  getAuthHeaders,
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
