import {
  act,
  click,
  createElement,
  deferred,
  describe,
  dlqConfigMutationPayload,
  expect,
  findButton,
  installTestHooks,
  json,
  render,
  StallForm,
  settle,
  stallConfig,
  stallConfigPayload,
  test,
  useConnectionStore,
} from './queue-control-audit.helpers';

installTestHooks();

describe('Queue config validation and save lifecycle', () => {
  test('mutable policy payloads normalize integers and omit DLQ retention', () => {
    expect(
      stallConfigPayload({ enabled: false, stallInterval: '0', maxStalls: '0', gracePeriod: '0' })
    ).toEqual({
      ok: true,
      value: { enabled: false, stallInterval: 0, maxStalls: 0, gracePeriod: 0 },
    });
    expect(
      stallConfigPayload({ enabled: true, stallInterval: '1.5', maxStalls: 3, gracePeriod: 0 }).ok
    ).toBe(false);
    expect(
      stallConfigPayload({ enabled: true, stallInterval: -1, maxStalls: 3, gracePeriod: 0 }).ok
    ).toBe(false);

    expect(
      dlqConfigMutationPayload({
        autoRetry: false,
        autoRetryInterval: '0',
        maxAutoRetries: '0',
        maxAge: -1,
        maxEntries: 0,
      })
    ).toEqual({
      ok: true,
      value: {
        autoRetry: false,
        autoRetryInterval: 0,
        maxAutoRetries: 0,
      },
    });
    expect(
      dlqConfigMutationPayload({
        autoRetry: false,
        autoRetryInterval: -1,
        maxAutoRetries: 1,
        maxAge: null,
        maxEntries: 1,
      }).ok
    ).toBe(false);
    expect(
      dlqConfigMutationPayload({
        autoRetry: false,
        autoRetryInterval: 1,
        maxAutoRetries: 1.5,
        maxAge: null,
        maxEntries: 1,
      }).ok
    ).toBe(false);
  });

  test('double-click saves once and an unmounted old queue cannot report success', async () => {
    const response = deferred<Response>();
    let calls = 0;
    let saved = 0;
    globalThis.fetch = (() => {
      calls += 1;
      return response.promise;
    }) as typeof fetch;

    const { host, unmount } = render(
      createElement(StallForm, {
        queue: 'q-a',
        config: stallConfig,
        onSaved: () => {
          saved += 1;
        },
      })
    );
    const saveButton = findButton(host, 'Save');
    act(() => {
      saveButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      saveButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    expect(calls).toBe(1);
    unmount();

    await act(async () => {
      response.resolve(json({ ok: true }));
      await new Promise((resolve) => setTimeout(resolve, 8));
    });
    expect(saved).toBe(0);
  });

  test('a same-name server retarget invalidates the old config save and unlocks the new one', async () => {
    const oldResponse = deferred<Response>();
    const calls: Array<{ url: string; auth: string | null }> = [];
    let saved = 0;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        auth: new Headers(init?.headers).get('Authorization'),
      });
      return calls.length === 1 ? oldResponse.promise : Promise.resolve(json({ ok: true }));
    }) as typeof fetch;

    const { host } = render(
      createElement(StallForm, {
        queue: 'shared-name',
        config: stallConfig,
        onSaved: () => {
          saved += 1;
        },
      })
    );
    click(host, 'Save');
    expect(calls).toEqual([
      { url: 'http://server.test/queues/shared-name/stall-config', auth: null },
    ]);

    act(() => {
      useConnectionStore.setState({ baseUrl: 'http://server-b.test', token: 'token-b' });
    });
    await settle(5);
    oldResponse.resolve(json({}));
    await settle(10);
    expect(saved).toBe(0);
    expect(host.textContent).not.toContain('Saved ✓');
    expect(host.textContent).not.toContain('Malformed /stall-config response');
    expect(findButton(host, 'Save').disabled).toBeFalse();

    click(host, 'Save');
    await settle(10);
    expect(calls[1]).toEqual({
      url: 'http://server-b.test/queues/shared-name/stall-config',
      auth: 'Bearer token-b',
    });
    expect(saved).toBe(1);
    expect(host.textContent).toContain('Saved ✓');
  });
});
