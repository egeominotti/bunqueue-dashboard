import {
  abortActive,
  afterEach,
  beforeEach,
  clearChat,
  describe,
  expect,
  sendMessage,
  test,
  useCopilotStore,
} from './copilot-fixes.helpers';

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
