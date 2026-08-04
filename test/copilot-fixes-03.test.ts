import {
  afterEach,
  beforeEach,
  buildTools,
  describe,
  expect,
  test,
  useConnectionStore,
  useCopilotStore,
} from './copilot-fixes.helpers';

describe('copilot flow-mutation surface', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    const s = useCopilotStore.getState();
    s.clear();
    s.setBusy(false);
    useConnectionStore.setState({ baseUrl: 'http://copilot-server', token: '', agentToken: '' });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    useConnectionStore.setState({ baseUrl: '/api', token: '', agentToken: '' });
  });

  test('exposes no retry/remove/purge tool and cannot issue a DLQ retry POST', () => {
    const calls: Array<{ url: string; method: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET' });
      return Response.json({ ok: true, count: 1 });
    }) as typeof fetch;

    const tools = buildTools('assistant-1') as Record<string, unknown>;
    expect(Object.keys(tools)).not.toContain('retry_job');
    expect(Object.keys(tools)).not.toContain('remove_job');
    expect(Object.keys(tools)).not.toContain('purge_dlq');
    expect(Object.keys(tools)).not.toContain('retry_dlq');
    expect(Object.keys(tools)).toContain('promote_job');
    expect(Object.keys(tools)).toContain('pause_queue');
    expect(Object.keys(tools)).toContain('resume_queue');
    expect(calls).toEqual([]);
  });

  test('an A confirmation cannot mutate after the live connection changes to B', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    useConnectionStore.setState({
      baseUrl: 'http://server-a.example',
      token: 'TOKEN-A',
      agentToken: '',
    });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET' });
      return Response.json({ ok: true });
    }) as typeof fetch;

    const s = useCopilotStore.getState();
    const msgId = s.startAssistant();
    const pending = buildTools(msgId).pause_queue.execute?.({ queue: 'orders' }, {} as never);
    await Promise.resolve();
    const confirmation = useCopilotStore.getState().pending[0];
    expect(confirmation.label).toContain('server http://server-a.example');

    useConnectionStore.setState({
      baseUrl: 'http://server-b.example',
      token: 'TOKEN-B',
      agentToken: '',
    });
    s.resolveConfirm(confirmation.id, true);

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('connection changed'),
    });
    expect(calls).toEqual([]);
  });

  test('a token-only change also invalidates an existing confirmation', async () => {
    const calls: string[] = [];
    useConnectionStore.setState({
      baseUrl: 'http://server-a.example',
      token: 'TOKEN-A',
      agentToken: '',
    });
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return Response.json({ ok: true });
    }) as typeof fetch;

    const s = useCopilotStore.getState();
    const pending = buildTools(s.startAssistant()).resume_queue.execute?.(
      { queue: 'orders' },
      {} as never
    );
    await Promise.resolve();
    const confirmation = useCopilotStore.getState().pending[0];
    useConnectionStore.setState({ token: 'TOKEN-B' });
    s.resolveConfirm(confirmation.id, true);

    await expect(pending).resolves.toMatchObject({ ok: false });
    expect(calls).toEqual([]);
  });

  test('read tools remain on the turn target and Bearer after a live retarget', async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    useConnectionStore.setState({
      baseUrl: 'http://server-a.example',
      token: 'TOKEN-A',
      agentToken: '',
    });
    const tools = buildTools(useCopilotStore.getState().startAssistant());
    useConnectionStore.setState({
      baseUrl: 'http://server-b.example',
      token: 'TOKEN-B',
      agentToken: '',
    });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        authorization: new Headers(init?.headers).get('Authorization'),
      });
      return Response.json([]);
    }) as typeof fetch;

    await expect(tools.list_queues.execute?.({}, {} as never)).resolves.toEqual([]);
    expect(calls).toEqual([
      {
        url: 'http://server-a.example/queues/summary',
        authorization: 'Bearer TOKEN-A',
      },
    ]);
  });
});

describe('copilot finishAssistant error reporting', () => {
  beforeEach(() => useCopilotStore.getState().clear());

  test('the failure reason survives even when text had already streamed', () => {
    const s = useCopilotStore.getState();
    const id = s.startAssistant();
    s.appendAssistant(id, 'Here are your queues: orders (12 waiting)');
    s.finishAssistant(id, { error: 'The provider is rate-limiting or overloaded. Retry.' });

    const m = useCopilotStore.getState().messages.find((x) => x.id === id);
    expect(m?.error).toBe(true);
    expect(m?.content).toContain('orders (12 waiting)');
    expect(m?.content).toContain('rate-limiting or overloaded');
  });

  test('an empty failed turn still shows just the reason', () => {
    const s = useCopilotStore.getState();
    const id = s.startAssistant();
    s.finishAssistant(id, { error: 'Add your API key.' });
    expect(useCopilotStore.getState().messages.find((x) => x.id === id)?.content).toBe(
      'Add your API key.'
    );
  });
});
