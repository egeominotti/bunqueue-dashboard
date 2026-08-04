import {
  act,
  click,
  createElement,
  DlqConfigForm,
  deferred,
  describe,
  dlqConfig,
  expect,
  findButton,
  installTestHooks,
  json,
  render,
  StallForm,
  StrictMode,
  settle,
  stallConfig,
  test,
  useConnectionStore,
} from './queue-control-audit.helpers';

installTestHooks();

describe('Queue config validation and save lifecycle', () => {
  test('an A→B→A batch cannot revive or keep a stale stall-config save locked', async () => {
    useConnectionStore.setState({ baseUrl: 'http://server-a.test', token: 'token-a' });
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
    act(() => {
      useConnectionStore.setState({ baseUrl: 'http://server-b.test', token: 'token-b' });
      useConnectionStore.setState({ baseUrl: 'http://server-a.test', token: 'token-a' });
    });
    await settle(5);
    expect(findButton(host, 'Save').disabled).toBeFalse();

    click(host, 'Save');
    await settle(10);
    expect(calls).toEqual([
      {
        url: 'http://server-a.test/queues/shared-name/stall-config',
        auth: 'Bearer token-a',
      },
      {
        url: 'http://server-a.test/queues/shared-name/stall-config',
        auth: 'Bearer token-a',
      },
    ]);
    expect(saved).toBe(1);
    expect(host.textContent).toContain('Saved ✓');

    oldResponse.resolve(json({}));
    await settle(10);
    expect(saved).toBe(1);
    expect(host.textContent).toContain('Saved ✓');
    expect(host.textContent).not.toContain('Malformed /stall-config response');
  });

  test('an A→B→A batch cannot revive or keep a stale DLQ-config save locked', async () => {
    useConnectionStore.setState({ baseUrl: 'http://server-a.test', token: 'token-a' });
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
      createElement(DlqConfigForm, {
        queue: 'shared-name',
        config: dlqConfig,
        onSaved: () => {
          saved += 1;
        },
      })
    );

    click(host, 'Save');
    act(() => {
      useConnectionStore.setState({ baseUrl: 'http://server-b.test', token: 'token-b' });
      useConnectionStore.setState({ baseUrl: 'http://server-a.test', token: 'token-a' });
    });
    await settle(5);
    expect(findButton(host, 'Save').disabled).toBeFalse();

    click(host, 'Save');
    await settle(10);
    expect(calls).toEqual([
      {
        url: 'http://server-a.test/queues/shared-name/dlq-config',
        auth: 'Bearer token-a',
      },
      {
        url: 'http://server-a.test/queues/shared-name/dlq-config',
        auth: 'Bearer token-a',
      },
    ]);
    expect(saved).toBe(1);
    expect(host.textContent).toContain('Saved ✓');

    oldResponse.resolve(json({}));
    await settle(10);
    expect(saved).toBe(1);
    expect(host.textContent).toContain('Saved ✓');
    expect(host.textContent).not.toContain('Malformed /dlq-config response');
  });

  test('save completion remains live through the StrictMode effect probe', async () => {
    let calls = 0;
    let saved = 0;
    globalThis.fetch = (() => {
      calls += 1;
      return Promise.resolve(json({ ok: true }));
    }) as typeof fetch;

    const { host } = render(
      createElement(
        StrictMode,
        null,
        createElement(StallForm, {
          queue: 'q-a',
          config: stallConfig,
          onSaved: () => {
            saved += 1;
          },
        })
      )
    );
    click(host, 'Save');
    await settle(12);
    expect(calls).toBe(1);
    expect(saved).toBe(1);
    expect(host.textContent).toContain('Saved ✓');
  });

  test('a malformed config mutation response is shown as an error, never Saved', async () => {
    globalThis.fetch = (() => Promise.resolve(json({}))) as typeof fetch;
    const { host } = render(
      createElement(StallForm, { queue: 'q-a', config: stallConfig, onSaved: () => undefined })
    );
    click(host, 'Save');
    await settle(12);
    expect(host.textContent).toContain('Malformed /stall-config response');
    expect(host.textContent).not.toContain('Saved ✓');
  });
});
