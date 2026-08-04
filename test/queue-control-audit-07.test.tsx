import {
  act,
  click,
  createElement,
  DlqConfigForm,
  describe,
  dlqConfig,
  expect,
  installTestHooks,
  json,
  render,
  settle,
  test,
} from './queue-control-audit.helpers';

installTestHooks();

describe('Queue config validation and save lifecycle', () => {
  test('DLQ auto-retry can only be disabled, never enabled', async () => {
    const disabledView = render(
      createElement(DlqConfigForm, {
        queue: 'q-a',
        config: dlqConfig,
        onSaved: () => undefined,
      })
    );
    const disabledToggle = disabledView.host.querySelector<HTMLButtonElement>(
      '[role="switch"][aria-label="auto-retry"]'
    );
    expect(disabledToggle?.disabled).toBe(true);
    const retentionInputs = [
      ...disabledView.host.querySelectorAll<HTMLInputElement>('input[type="number"]'),
    ].filter((input) => input.value === '604800000' || input.value === '10000');
    expect(retentionInputs).toHaveLength(2);
    for (const input of retentionInputs) {
      expect(input.disabled).toBe(true);
      expect(input.readOnly).toBe(true);
      expect(input.title).toContain('read-only');
    }
    disabledView.unmount();

    let body: unknown;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = init?.body ? JSON.parse(String(init.body)) : undefined;
      return json({ ok: true });
    }) as typeof fetch;
    const enabledView = render(
      createElement(DlqConfigForm, {
        queue: 'q-a',
        config: { ...dlqConfig, autoRetry: true },
        onSaved: () => undefined,
      })
    );
    const enabledToggle = enabledView.host.querySelector<HTMLButtonElement>(
      '[role="switch"][aria-label="auto-retry"]'
    );
    expect(enabledToggle?.disabled).toBe(false);
    act(() => enabledToggle?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    click(enabledView.host, 'Save');
    await settle(10);
    expect(body).toEqual({
      config: {
        autoRetry: false,
        autoRetryInterval: 3_600_000,
        maxAutoRetries: 3,
      },
    });
    expect((body as { config: Record<string, unknown> }).config).not.toHaveProperty('maxAge');
    expect((body as { config: Record<string, unknown> }).config).not.toHaveProperty('maxEntries');
  });
});
