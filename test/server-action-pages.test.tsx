import {
  act,
  createElement,
  DlqControl,
  dashboardQueue,
  describe,
  expect,
  installTestHooks,
  JobsPro,
  json,
  MemoryRouter,
  queueSummary,
  render,
  settle,
  test,
  useToastStore,
} from './server-action-pages.helpers';

installTestHooks();

describe('guarded job and entity actions', () => {
  test('JobsPro exposes no cancel, DLQ retry, or completed requeue mutation', async () => {
    let deleteCalls = 0;
    let retryCalls = 0;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/queues/summary')) {
        return Promise.resolve(json([queueSummary('orders')]));
      }
      if (url.endsWith('/stats')) {
        return Promise.resolve(
          json({
            ok: true,
            stats: {
              completed: 0,
              failed: 0,
              waiting: 1,
              prioritized: 0,
              active: 0,
              delayed: 0,
              'waiting-children': 0,
            },
          })
        );
      }
      if (url.includes('/queues/orders/jobs/list?')) {
        return Promise.resolve(
          json({
            ok: true,
            jobs: [
              { id: 'job-1', queue: 'orders', state: 'waiting' },
              { id: 'failed-1', queue: 'orders', state: 'failed' },
              { id: 'completed-1', queue: 'orders', state: 'completed' },
            ],
          })
        );
      }
      if (url.endsWith('/jobs/job-1') && method === 'DELETE') {
        deleteCalls += 1;
        return Promise.resolve(json({ ok: true }));
      }
      if (
        method === 'POST' &&
        (url.endsWith('/queues/orders/dlq/retry') || url.endsWith('/queues/orders/retry-completed'))
      ) {
        retryCalls += 1;
        return Promise.resolve(json({ ok: true, count: 1 }));
      }
      return Promise.resolve(json({ ok: false, error: `Unexpected ${method} ${url}` }, 500));
    }) as typeof fetch;

    const view = render(
      createElement(MemoryRouter, { initialEntries: ['/jobs'] }, createElement(JobsPro))
    );
    await settle(25);
    const cancel = view.host.querySelector<HTMLButtonElement>('button[aria-label="Cancel job"]');
    expect(cancel).toBeNull();
    expect(view.host.querySelector('button[aria-label="Retry job"]')).toBeNull();
    expect(view.host.querySelector('button[aria-label="Requeue job"]')).toBeNull();
    expect(view.host.textContent).not.toContain('Retry selected');
    expect(view.host.textContent).not.toContain('Requeue selected');
    expect(deleteCalls).toBe(0);
    expect(retryCalls).toBe(0);
    expect(view.host.textContent).toContain('job-1');
    expect(view.host.textContent).toContain('failed-1');
    expect(view.host.textContent).toContain('completed-1');
    view.unmount();
  });

  test('DlqControl exposes no row retry and cannot issue its POST', async () => {
    let retryCalls = 0;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('/dashboard/queues?')) {
        return Promise.resolve(
          json({
            ok: true,
            queues: [dashboardQueue('orders', 1)],
            total: 1,
            limit: 500,
            offset: 0,
            timestamp: Date.now(),
          })
        );
      }
      if (url.includes('/queues/orders/dlq/stats')) {
        return Promise.resolve(
          json({ ok: true, stats: { byReason: { failed: 1 }, pendingRetry: 0 } })
        );
      }
      if (url.includes('/queues/orders/dlq?')) {
        return Promise.resolve(
          json({
            ok: true,
            entries: [
              {
                job: { id: 'dead-1', queue: 'orders', attempts: 1 },
                enteredAt: 1000,
                reason: 'failed',
                error: 'boom',
              },
            ],
            total: 1,
          })
        );
      }
      if (url.endsWith('/queues/orders/dlq/retry') && method === 'POST') {
        retryCalls += 1;
        return Promise.resolve(json({ ok: true, count: 1 }));
      }
      return Promise.resolve(json({ ok: false, error: `Unexpected ${method} ${url}` }, 500));
    }) as typeof fetch;

    const view = render(createElement(MemoryRouter, {}, createElement(DlqControl)));
    await settle(35);
    const retry = view.host.querySelector<HTMLButtonElement>('button[aria-label="Retry job"]');
    expect(retry).toBeNull();
    const unavailable = view.host.querySelector<HTMLButtonElement>(
      'button[aria-label="Retry job unavailable"]'
    );
    expect(unavailable?.disabled).toBe(true);
    act(() => unavailable?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    expect(retryCalls).toBe(0);
    expect(useToastStore.getState().toasts).toEqual([]);
    view.unmount();
  });
});
