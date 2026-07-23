import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { CopilotBoundary } from '../src/components/copilot/Copilot';
import { useCopilotStore } from '../src/components/dashboard/stores/copilotStore';
import { createModel } from '../src/lib/copilot/providers';
import { clearChat } from '../src/lib/copilot/runtime';
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
    const purge = s.requestConfirm({
      name: 'purge_dlq',
      label: 'Purge DLQ: B',
      args: { queue: 'B' },
    });

    const pending = useCopilotStore.getState().pending;
    expect(pending).toHaveLength(2);
    expect(pending[0].id).not.toBe(pending[1].id);

    // Approving the benign card must settle ONLY that card's promise; the
    // destructive one stays pending and un-run.
    s.resolveConfirm(pending[0].id, true);
    expect(await pause).toBe(true);
    expect(useCopilotStore.getState().pending).toHaveLength(1);
    expect(useCopilotStore.getState().pending[0].label).toBe('Purge DLQ: B');

    s.resolveConfirm(useCopilotStore.getState().pending[0].id, false);
    expect(await purge).toBe(false);
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
    const b = tools.purge_dlq.execute?.({ queue: 'B' }, {} as never);
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
    s.addUser('clean up the prod DLQ');
    s.startAssistant();
    s.setBusy(true);
    const suspended = s.requestConfirm({
      name: 'purge_dlq',
      label: 'Purge DLQ: prod',
      args: { queue: 'prod' },
    });

    clearChat();

    expect(await suspended).toBe(false); // no bq.purgeDlq call
    const st = useCopilotStore.getState();
    expect(st.messages).toHaveLength(0);
    expect(st.pending).toHaveLength(0);
    expect(st.busy).toBe(false);
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
});
