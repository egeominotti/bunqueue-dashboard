import {
  act,
  actionResultCount,
  click,
  deferred,
  describe,
  dlqConfig,
  expect,
  findButton,
  installTestHooks,
  json,
  queueDetail,
  queuePage,
  queueSummaryEntry,
  renderControl,
  settle,
  setValue,
  stallConfig,
  test,
} from './queue-control-audit.helpers';

installTestHooks();

describe('QueueControl mutation races and response semantics', () => {
  test('double-click submits once and malformed action success is rejected', async () => {
    const pause = deferred<Response>();
    let pauseCalls = 0;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/dashboard/queues') return Promise.resolve(json(queuePage(['q-a'])));
      if (url.pathname === '/dashboard/queues/q-a') {
        return Promise.resolve(json(queueDetail('q-a')));
      }
      if (url.pathname === '/queues/summary') {
        return Promise.resolve(json([queueSummaryEntry('q-a')]));
      }
      if (url.pathname.endsWith('/stall-config')) {
        return Promise.resolve(json({ ok: true, config: stallConfig }));
      }
      if (url.pathname.endsWith('/dlq-config')) {
        return Promise.resolve(json({ ok: true, config: dlqConfig }));
      }
      if (url.pathname === '/queues/q-a/pause' && init?.method === 'POST') {
        pauseCalls += 1;
        return pause.promise;
      }
      return Promise.resolve(json({ ok: false, error: 'unexpected request' }, 500));
    }) as typeof fetch;

    const { host } = renderControl();
    await settle(35);
    const pauseButton = findButton(host, 'Pause');
    act(() => {
      pauseButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      pauseButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    await settle(2);
    expect(pauseCalls).toBe(1);

    await act(async () => {
      pause.resolve(json({}));
      await new Promise((resolve) => setTimeout(resolve, 8));
    });
    expect(host.textContent).toContain('Malformed queue action response');
    expect(host.textContent).not.toContain('Paused ✓');
  });

  test('an old queue action cannot publish success under a new selection', async () => {
    const pause = deferred<Response>();
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/dashboard/queues') {
        return Promise.resolve(json(queuePage(['q-a', 'q-b'])));
      }
      if (url.pathname === '/dashboard/queues/q-a') {
        return Promise.resolve(json(queueDetail('q-a', 1)));
      }
      if (url.pathname === '/dashboard/queues/q-b') {
        return Promise.resolve(json(queueDetail('q-b', 42)));
      }
      if (url.pathname === '/queues/summary') {
        return Promise.resolve(json([queueSummaryEntry('q-a'), queueSummaryEntry('q-b')]));
      }
      if (url.pathname.endsWith('/stall-config')) {
        return Promise.resolve(json({ ok: true, config: stallConfig }));
      }
      if (url.pathname.endsWith('/dlq-config')) {
        return Promise.resolve(json({ ok: true, config: dlqConfig }));
      }
      if (url.pathname === '/queues/q-a/pause' && init?.method === 'POST') return pause.promise;
      return Promise.resolve(json({ ok: false, error: 'unexpected request' }, 500));
    }) as typeof fetch;

    const { host } = renderControl();
    await settle(35);
    click(host, 'Pause');
    const picker = host.querySelector('[name="queue-control-queue"]') as HTMLSelectElement;
    setValue(picker, 'q-b');
    await settle(25);

    await act(async () => {
      pause.resolve(json({ ok: true }));
      await new Promise((resolve) => setTimeout(resolve, 8));
    });
    expect(picker.value).toBe('q-b');
    expect(host.textContent).toContain('42');
    expect(host.textContent).not.toContain('Paused ✓');
  });

  test('strict action result parsing accepts only the v2.8.55 success shape', () => {
    expect(actionResultCount({ ok: true })).toBeUndefined();
    expect(actionResultCount({ ok: true, count: 0 })).toBe(0);
    expect(() => actionResultCount(undefined)).toThrow('expected { ok: true }');
    expect(() => actionResultCount({ ok: true, count: -1 })).toThrow('non-negative integer');
    expect(() => actionResultCount({ ok: true, count: 1.5 })).toThrow('non-negative integer');
  });
});
