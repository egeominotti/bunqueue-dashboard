import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { CopilotBoundary } from '../src/components/copilot/Copilot';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { useCopilotStore } from '../src/components/dashboard/stores/copilotStore';
import {
  createModel,
  normalizeCustomProviderBaseURL,
  providerById,
  resolveCompatibleProviderBaseURL,
} from '../src/lib/copilot/providers';
import { abortActive, clearChat, sendMessage } from '../src/lib/copilot/runtime';
import { buildTools } from '../src/lib/copilot/tools';
import { ensureDom } from './domSetup';

/**
 * Regressions for the copilot audit pass.
 *
 * The central one is the id generator: crypto.randomUUID is gated on a SECURE
 * context, so on a plain-http origin (the documented LAN/Docker deployment) the
 * fallback branch is the ONLY branch that ever runs. `withoutRandomUUID` puts the
 * tests in exactly that world, with Date.now frozen so any ms-resolution id
 * generator is guaranteed to collide.
 */
const realCrypto = globalThis.crypto;
const realNow = Date.now;

function withoutRandomUUID(): void {
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    writable: true,
    value: { getRandomValues: realCrypto.getRandomValues.bind(realCrypto) },
  });
  Date.now = () => 1784764361322;
}

function restoreCrypto(): void {
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    writable: true,
    value: realCrypto,
  });
  Date.now = realNow;
}

describe('copilot id generation on a non-secure origin', () => {
  beforeEach(() => {
    const s = useCopilotStore.getState();
    s.clear();
    s.setBusy(false);
    withoutRandomUUID();
  });
  afterEach(restoreCrypto);

  test('crypto.randomUUID really is unavailable in this test world', () => {
    expect(globalThis.crypto.randomUUID).toBeUndefined();
  });

  test('two confirms requested in the same millisecond get distinct ids and keep both resolvers', async () => {
    const s = useCopilotStore.getState();
    const pause = s.requestConfirm({ name: 'pause_queue', label: 'Pause A', args: { queue: 'A' } });
    const resume = s.requestConfirm({
      name: 'resume_queue',
      label: 'Resume B',
      args: { queue: 'B' },
    });

    const pending = useCopilotStore.getState().pending;
    expect(pending).toHaveLength(2);
    expect(pending[0].id).not.toBe(pending[1].id);

    // Approving the benign card must settle ONLY that card's promise; the
    // second one stays pending and un-run.
    s.resolveConfirm(pending[0].id, true);
    expect(await pause).toBe(true);
    expect(useCopilotStore.getState().pending).toHaveLength(1);
    expect(useCopilotStore.getState().pending[0].label).toBe('Resume B');

    s.resolveConfirm(useCopilotStore.getState().pending[0].id, false);
    expect(await resume).toBe(false);
  });

  test('user and assistant messages minted in the same millisecond do not merge', () => {
    const s = useCopilotStore.getState();
    s.addUser('hello');
    const assistantId = s.startAssistant();
    s.appendAssistant(assistantId, 'hi there');

    const messages = useCopilotStore.getState().messages;
    expect(messages).toHaveLength(2);
    expect(messages[0].id).not.toBe(messages[1].id);
    expect(messages[0].content).toBe('hello');
    expect(messages[1].content).toBe('hi there');
  });

  test('two tools started in the same millisecond get distinct ToolEvent ids', async () => {
    const s = useCopilotStore.getState();
    const msgId = s.startAssistant();
    const tools = buildTools(msgId);

    // Mutating tools suspend on the confirm gate before touching bq, so this
    // exercises the ToolEvent bookkeeping without any network.
    const a = tools.pause_queue.execute?.({ queue: 'A' }, {} as never);
    const b = tools.resume_queue.execute?.({ queue: 'B' }, {} as never);
    await Promise.resolve();

    const events = useCopilotStore.getState().messages.find((m) => m.id === msgId)?.tools ?? [];
    expect(events).toHaveLength(2);
    expect(events[0].id).not.toBe(events[1].id);

    // Declining one must mark only its own chip; the other stays 'awaiting'.
    const pending = useCopilotStore.getState().pending;
    s.resolveConfirm(pending[0].id, false);
    await a;
    const after = useCopilotStore.getState().messages.find((m) => m.id === msgId)?.tools ?? [];
    expect(after[0].status).toBe('declined');
    expect(after[1].status).toBe('awaiting');

    s.resolveConfirm(useCopilotStore.getState().pending[0].id, false);
    await b;
  });
});

describe('copilot clear chat', () => {
  beforeEach(() => {
    const s = useCopilotStore.getState();
    s.clear();
    s.setBusy(false);
  });

  test('clearChat declines pending confirms, wipes the chat and releases the busy lock', async () => {
    const s = useCopilotStore.getState();
    s.addUser('pause the prod queue');
    s.startAssistant();
    s.setBusy(true);
    const suspended = s.requestConfirm({
      name: 'pause_queue',
      label: 'Pause prod',
      args: { queue: 'prod' },
    });

    clearChat();

    expect(await suspended).toBe(false); // no bq.pause call
    const st = useCopilotStore.getState();
    expect(st.messages).toHaveLength(0);
    expect(st.pending).toHaveLength(0);
    expect(st.busy).toBe(false);
  });
});

describe('copilot turn ownership', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    clearChat();
    useCopilotStore.getState().setConfig({
      provider: 'anthropic',
      model: 'claude-3-5-haiku-latest',
      apiKey: 'sk-test-only',
    });
  });

  afterEach(() => {
    abortActive();
    globalThis.fetch = originalFetch;
    useCopilotStore.getState().setConfig({ apiKey: '' });
    useCopilotStore.getState().clear();
  });

  test('same-tick sends create one stream and Stop owns and aborts that turn', async () => {
    const signals: AbortSignal[] = [];
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) signals.push(signal);
        const abort = () => reject(new DOMException('Aborted', 'AbortError'));
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      })) as typeof fetch;

    const first = sendMessage('first turn');
    const duplicate = sendMessage('duplicate turn');

    // Acquisition is synchronous: the duplicate is rejected before either
    // caller yields to React or creates another user/assistant pair.
    expect(useCopilotStore.getState().messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
    ]);
    expect(useCopilotStore.getState().busy).toBe(true);

    for (let i = 0; i < 50 && signals.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(signals).toHaveLength(1);

    abortActive();
    await Promise.race([
      Promise.all([first, duplicate]),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Copilot turn did not stop')), 500)
      ),
    ]);

    expect(signals[0].aborted).toBe(true);
    const state = useCopilotStore.getState();
    expect(state.busy).toBe(false);
    expect(state.pending).toHaveLength(0);
    expect(state.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(state.messages[1].done).toBe(true);
  });
});

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
