import { beforeEach, describe, expect, test } from 'bun:test';
import {
  type CopilotConfig,
  persistedCopilotState,
  useCopilotStore,
} from '../src/components/dashboard/stores/copilotStore';
import { abortActive } from '../src/lib/copilot/runtime';

/**
 * Copilot safety properties. The confirmation gate is the mechanism that keeps
 * the model from mutating the server without an explicit user click, and Stop
 * must neutralize a pending mutation deterministically (the AI SDK does NOT
 * reject the stream when a tool is suspended on a confirmation, so cleanup can't
 * rely on a thrown AbortError). These lock that behavior.
 */
describe('copilot confirmation gate', () => {
  beforeEach(() => {
    const s = useCopilotStore.getState();
    s.clear();
    s.setBusy(false);
  });

  test('requestConfirm resolves true only when the user confirms', async () => {
    const s = useCopilotStore.getState();
    const p = s.requestConfirm({ name: 'pause_queue', label: 'Pause x', args: { queue: 'x' } });
    expect(useCopilotStore.getState().pending).toHaveLength(1);
    const id = useCopilotStore.getState().pending[0].id;
    s.resolveConfirm(id, true);
    expect(await p).toBe(true);
    expect(useCopilotStore.getState().pending).toHaveLength(0);
  });

  test('requestConfirm resolves false when declined', async () => {
    const s = useCopilotStore.getState();
    const p = s.requestConfirm({ name: 'purge_dlq', label: 'Purge x', args: { queue: 'x' } });
    const id = useCopilotStore.getState().pending[0].id;
    s.resolveConfirm(id, false);
    expect(await p).toBe(false);
  });

  test('abortActive declines every pending confirm and clears busy (no post-Stop mutation)', async () => {
    const s = useCopilotStore.getState();
    s.setBusy(true);
    // A mutating tool suspended on its confirmation, exactly as tools.ts::run awaits it.
    const suspended = s.requestConfirm({
      name: 'retry_dlq',
      label: 'Retry ALL DLQ',
      args: { queue: 'e' },
    });
    expect(useCopilotStore.getState().pending).toHaveLength(1);

    abortActive(); // the Stop button

    // The suspended tool resumes with `false` -> tools.ts returns {declined}, no bq call.
    expect(await suspended).toBe(false);
    expect(useCopilotStore.getState().pending).toHaveLength(0);
    expect(useCopilotStore.getState().busy).toBe(false);
  });

  test('abortActive / cancelPending does not wipe chat history', () => {
    const s = useCopilotStore.getState();
    s.addUser('hello');
    const before = useCopilotStore.getState().messages.length;
    void s.requestConfirm({ name: 'pause_queue', label: 'Pause y', args: { queue: 'y' } });
    abortActive();
    expect(useCopilotStore.getState().messages).toHaveLength(before);
  });
});

describe('copilot key handling', () => {
  test('the persisted projection excludes the API key, keeps the non-secret setup', () => {
    const config: CopilotConfig = {
      provider: 'anthropic',
      baseURL: 'https://api.example/v1',
      model: 'claude-x',
      apiKey: 'sk-ant-SECRET-DO-NOT-PERSIST',
    };
    const persisted = persistedCopilotState({ config });
    const serialized = JSON.stringify(persisted);
    expect(serialized).not.toContain('sk-ant-SECRET-DO-NOT-PERSIST');
    expect(persisted.config).not.toHaveProperty('apiKey');
    expect(persisted.config).toMatchObject({ provider: 'anthropic', model: 'claude-x' });
  });
});
