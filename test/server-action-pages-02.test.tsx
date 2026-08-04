import {
  act,
  buttonByText,
  clickSameTick,
  createElement,
  DlqPro,
  dashboardQueue,
  deferred,
  describe,
  expect,
  installTestHooks,
  json,
  MemoryRouter,
  QueuesOverview,
  queueSummary,
  render,
  settle,
  test,
  useConnectionStore,
  WorkersPro,
} from './server-action-pages.helpers';

installTestHooks();

describe('guarded job and entity actions', () => {
  test('WorkersPro synchronously locks unregister by worker id', async () => {
    const mutation = deferred<Response>();
    let deletes = 0;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/workers') && method === 'GET') {
        return Promise.resolve(
          json({
            ok: true,
            data: {
              workers: [
                {
                  id: 'worker-1',
                  name: 'worker',
                  queues: ['orders'],
                  concurrency: 1,
                  hostname: 'worker.test',
                  pid: 42,
                  status: 'stale',
                  registeredAt: Date.now() - 1_000,
                  activeJobs: 0,
                  processedJobs: 1,
                  failedJobs: 0,
                  lastSeen: Date.now(),
                  currentJob: null,
                  uptime: 1_000,
                },
              ],
            },
          })
        );
      }
      if (url.endsWith('/workers/worker-1') && method === 'DELETE') {
        deletes += 1;
        return mutation.promise;
      }
      return Promise.resolve(json({ ok: false, error: `Unexpected ${method} ${url}` }, 500));
    }) as typeof fetch;

    const view = render(createElement(WorkersPro));
    await settle(20);
    const remove = view.host.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove stale registry record for worker worker-1"]'
    );
    expect(remove).not.toBeNull();
    clickSameTick(remove as HTMLButtonElement);
    expect(deletes).toBe(1);
    mutation.resolve(json({ ok: true }));
    await settle(20);
    expect(view.host.textContent).toContain('Removed stale registry record for worker-1');
    view.unmount();
  });
});

describe('retarget-safe bounded fan-outs', () => {
  test('QueuesOverview starts no new pool calls after a server retarget', async () => {
    const pending: Array<ReturnType<typeof deferred<Response>>> = [];
    const mutationUrls: string[] = [];
    const queues = Array.from({ length: 8 }, (_, index) => queueSummary(`q${index + 1}`));
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/queues/summary') && method === 'GET') {
        return Promise.resolve(json(queues));
      }
      if (url.includes('/queues/q') && url.endsWith('/pause') && method === 'POST') {
        mutationUrls.push(url);
        const request = deferred<Response>();
        pending.push(request);
        return request.promise;
      }
      return Promise.resolve(json({ ok: false, error: `Unexpected ${method} ${url}` }, 500));
    }) as typeof fetch;

    const view = render(createElement(MemoryRouter, {}, createElement(QueuesOverview)));
    await settle(20);
    clickSameTick(buttonByText(view.host, 'Pause all'), 1);
    await settle(10);
    expect(mutationUrls).toHaveLength(6);

    act(() => useConnectionStore.setState({ baseUrl: 'http://server-b.test' }));
    for (const request of pending) request.resolve(json({ ok: true }));
    await settle(25);
    expect(mutationUrls).toHaveLength(6);
    expect(view.host.textContent).not.toContain('Paused 8/8 queues');
    view.unmount();
  });

  test('DlqPro keeps global retry and purge disabled and sends no mutation', async () => {
    const mutationUrls: string[] = [];
    const queues = Array.from({ length: 8 }, (_, index) => dashboardQueue(`q${index + 1}`, 1));
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('/dashboard/queues?') && method === 'GET') {
        return Promise.resolve(
          json({
            ok: true,
            queues,
            total: queues.length,
            limit: 500,
            offset: 0,
            timestamp: Date.now(),
          })
        );
      }
      if (url.includes('/dlq/stats') && method === 'GET') {
        return Promise.resolve(json({ ok: true, stats: { byReason: {}, pendingRetry: 0 } }));
      }
      if (url.includes('/dlq?') && method === 'GET') {
        return Promise.resolve(json({ ok: true, entries: [], total: 0 }));
      }
      if (url.endsWith('/dlq/retry') && method === 'POST') {
        mutationUrls.push(url);
        return Promise.resolve(json({ ok: true, count: 1 }));
      }
      if (url.endsWith('/dlq/purge') && method === 'POST') {
        mutationUrls.push(url);
        return Promise.resolve(json({ ok: true, count: 1 }));
      }
      return Promise.resolve(json({ ok: false, error: `Unexpected ${method} ${url}` }, 500));
    }) as typeof fetch;

    const view = render(
      createElement(MemoryRouter, { initialEntries: ['/dlq'] }, createElement(DlqPro))
    );
    await settle(35);
    const retryAll = buttonByText(view.host, 'Retry all (8 queues)');
    const purgeAll = buttonByText(view.host, 'Purge all (8 queues)');
    expect(retryAll.disabled).toBeTrue();
    expect(purgeAll.disabled).toBeTrue();
    act(() => {
      retryAll.click();
      purgeAll.click();
    });
    await settle(10);
    expect(mutationUrls).toEqual([]);
    view.unmount();
  });
});
