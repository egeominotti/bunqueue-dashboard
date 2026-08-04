import {
  afterEach,
  beforeEach,
  buildTools,
  clearChat,
  describe,
  expect,
  restoreCrypto,
  test,
  useCopilotStore,
  withoutRandomUUID,
} from './copilot-fixes.helpers';

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
