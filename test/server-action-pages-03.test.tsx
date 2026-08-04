import {
  act,
  buttonByText,
  clickSameTick,
  createElement,
  deferred,
  describe,
  expect,
  installTestHooks,
  json,
  render,
  setInput,
  settle,
  test,
  Webhooks,
} from './server-action-pages.helpers';

installTestHooks();

describe('webhook mutation intent', () => {
  const webhook = (enabled = false) => ({
    id: 'hook-1',
    url: 'https://example.test/hook',
    events: ['job.completed'],
    enabled,
    successCount: 0,
    failureCount: 0,
    lastTriggered: null,
    queue: null,
    createdAt: 1_000,
  });

  test('same-tick form submits and deletes each issue one mutation', async () => {
    const add = deferred<Response>();
    const remove = deferred<Response>();
    let addCalls = 0;
    let removeCalls = 0;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/webhooks') && method === 'GET') {
        return Promise.resolve(json({ ok: true, data: { webhooks: [webhook()] } }));
      }
      if (url.endsWith('/webhooks') && method === 'POST') {
        addCalls += 1;
        return add.promise;
      }
      if (url.endsWith('/webhooks/hook-1') && method === 'DELETE') {
        removeCalls += 1;
        return remove.promise;
      }
      return Promise.resolve(json({ ok: false, error: `Unexpected ${method} ${url}` }, 500));
    }) as typeof fetch;

    const view = render(createElement(Webhooks));
    await settle(20);
    const url = view.host.querySelector<HTMLInputElement>(
      'input[placeholder="https://example.com/hook"]'
    );
    expect(url).not.toBeNull();
    setInput(url as HTMLInputElement, 'https://receiver.test/hook');
    expect((url as HTMLInputElement).value).toBe('https://receiver.test/hook');
    const addButton = buttonByText(view.host, 'Add webhook');
    // HTMLElement.click() performs the submit button's default form action;
    // dispatchEvent(MouseEvent) alone only invokes explicit onClick handlers.
    act(() => {
      addButton.click();
      addButton.click();
    });
    expect(addCalls).toBe(1);
    add.resolve(json({ ok: true, id: 'new-hook' }));
    await settle(20);

    const deleteButton = view.host.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove webhook"]'
    );
    expect(deleteButton).not.toBeNull();
    clickSameTick(deleteButton as HTMLButtonElement);
    expect(removeCalls).toBe(1);
    remove.resolve(json({ ok: true }));
    await settle(20);
    view.unmount();
  });

  test('serializes and coalesces toggle writes so the latest intent wins on the server', async () => {
    const toggles: Array<{
      request: ReturnType<typeof deferred<Response>>;
      enabled: boolean;
    }> = [];
    let webhookGets = 0;
    let serverEnabled = false;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/webhooks') && method === 'GET') {
        webhookGets += 1;
        return Promise.resolve(json({ ok: true, data: { webhooks: [webhook(serverEnabled)] } }));
      }
      if (url.endsWith('/webhooks/hook-1/enabled') && method === 'PUT') {
        const request = deferred<Response>();
        const body = JSON.parse(String(init?.body)) as { enabled: boolean };
        toggles.push({ request, enabled: body.enabled });
        return request.promise;
      }
      return Promise.resolve(json({ ok: false, error: `Unexpected ${method} ${url}` }, 500));
    }) as typeof fetch;

    const view = render(createElement(Webhooks));
    await settle(20);
    const toggle = view.host.querySelector<HTMLButtonElement>('button[role="switch"]');
    expect(toggle?.getAttribute('aria-checked')).toBe('false');

    clickSameTick(toggle as HTMLButtonElement, 1); // intent 1: true
    await settle(5);
    clickSameTick(toggle as HTMLButtonElement, 1); // intent 2: false (latest)
    await settle(5);
    expect(toggles.map(({ enabled }) => enabled)).toEqual([true]);
    expect(toggle?.getAttribute('aria-checked')).toBe('false');

    serverEnabled = toggles[0]?.enabled ?? false;
    toggles[0]?.request.resolve(json({ ok: true }));
    await settle(10);
    expect(toggles.map(({ enabled }) => enabled)).toEqual([true, false]);
    expect(toggle?.getAttribute('aria-checked')).toBe('false');
    expect(webhookGets).toBe(1);

    serverEnabled = toggles[1]?.enabled ?? true;
    toggles[1]?.request.resolve(json({ ok: true }));
    await settle(20);
    expect(serverEnabled).toBe(false);
    expect(toggle?.getAttribute('aria-checked')).toBe('false');
    expect(webhookGets).toBe(2);
    view.unmount();
  });
});
