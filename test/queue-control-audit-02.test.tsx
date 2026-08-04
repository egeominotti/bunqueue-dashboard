import {
  act,
  deferred,
  describe,
  dlqConfig,
  expect,
  installTestHooks,
  json,
  queueDetail,
  queuePage,
  renderControl,
  settle,
  setValue,
  stallConfig,
  test,
  useConnectionStore,
} from './queue-control-audit.helpers';

installTestHooks();

describe('QueueControl v2.8.55 discovery and response integrity', () => {
  test('a late detail response cannot retarget the selected queue', async () => {
    const oldDetail = deferred<Response>();
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/dashboard/queues') {
        return Promise.resolve(json(queuePage(['q-a', 'q-b'])));
      }
      if (url.pathname === '/dashboard/queues/q-a') return oldDetail.promise;
      if (url.pathname === '/dashboard/queues/q-b') {
        return Promise.resolve(json(queueDetail('q-b', 22)));
      }
      if (url.pathname.endsWith('/stall-config')) {
        return Promise.resolve(json({ ok: true, config: stallConfig }));
      }
      if (url.pathname.endsWith('/dlq-config')) {
        return Promise.resolve(json({ ok: true, config: dlqConfig }));
      }
      return Promise.resolve(json({ ok: false, error: 'unexpected request' }, 500));
    }) as typeof fetch;

    const { host } = renderControl();
    await settle(20);
    const picker = host.querySelector('[name="queue-control-queue"]') as HTMLSelectElement;
    setValue(picker, 'q-b');
    await settle(20);
    expect(host.textContent).toContain('22');

    await act(async () => {
      oldDetail.resolve(json(queueDetail('q-a', 99)));
      await new Promise((resolve) => setTimeout(resolve, 8));
    });
    expect(picker.value).toBe('q-b');
    expect(host.textContent).toContain('22');
    expect(host.textContent).not.toContain('99');
  });

  test('a malformed refresh keeps the last snapshot and marks it stale', async () => {
    useConnectionStore.setState({ refreshMs: 20 });
    let detailCalls = 0;
    const malformedRefresh = deferred<Response>();
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/dashboard/queues') return Promise.resolve(json(queuePage(['q-a'])));
      if (url.pathname === '/dashboard/queues/q-a') {
        detailCalls += 1;
        return detailCalls === 1
          ? Promise.resolve(json(queueDetail('q-a', 17)))
          : malformedRefresh.promise;
      }
      if (url.pathname.endsWith('/stall-config')) {
        return Promise.resolve(json({ ok: true, config: stallConfig }));
      }
      if (url.pathname.endsWith('/dlq-config')) {
        return Promise.resolve(json({ ok: true, config: dlqConfig }));
      }
      return Promise.resolve(json({ ok: false, error: 'unexpected request' }, 500));
    }) as typeof fetch;

    const { host, unmount } = renderControl();
    await settle(20);
    await settle(30);
    expect(host.textContent).toContain('17');
    expect(host.textContent).toContain('prioritized');
    expect(host.textContent).toContain('waiting-children');
    expect(detailCalls).toBe(2);

    await act(async () => {
      malformedRefresh.resolve(json({ ok: true }));
      await new Promise((resolve) => setTimeout(resolve, 8));
    });
    expect(host.textContent).toContain('Queue refresh failed');
    expect(host.textContent).toContain('17');
    expect(host.textContent).not.toContain('Something went wrong');
    unmount();
  });
});
