import {
  act,
  createElement,
  describe,
  expect,
  installTestHooks,
  Jobs,
  json,
  MemoryRouter,
  render,
  settle,
  test,
  useConnectionStore,
} from './job-queue-pages-fixes.helpers';

installTestHooks();

describe('Jobs classic — async failures and all-queue scope', () => {
  test('server retarget aborts the old pinned job-list pool without mixing credentials', async () => {
    const names = Array.from({ length: 10 }, (_, index) => `q${index + 1}`);
    const oldSignals: AbortSignal[] = [];
    const listCalls: Array<{ url: string; auth: string | null }> = [];
    useConnectionStore.setState({ baseUrl: 'http://srv', token: 'alpha' });
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/dashboard/queues')) {
        const currentNames = url.startsWith('http://server-b.test') ? ['qb'] : names;
        return Promise.resolve(
          json({
            ok: true,
            queues: currentNames.map((name) => ({
              name,
              waiting: 0,
              delayed: 0,
              active: 0,
              dlq: 0,
              paused: false,
            })),
            total: currentNames.length,
            limit: 500,
            offset: 0,
            timestamp: Date.now(),
          })
        );
      }
      if (url.endsWith('/dashboard')) {
        return Promise.resolve(
          json({
            ok: true,
            stats: { waiting: 0, active: 0, totalCompleted: 0, totalFailed: 0 },
          })
        );
      }
      if (url.includes('/jobs/list')) {
        listCalls.push({ url, auth: new Headers(init?.headers).get('Authorization') });
        if (url.startsWith('http://srv/')) {
          const signal = init?.signal;
          if (!signal) throw new Error('job-list request has no lifecycle signal');
          oldSignals.push(signal);
          return new Promise<Response>((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => reject(new DOMException('Aborted', 'AbortError')),
              { once: true }
            );
          });
        }
        return Promise.resolve(
          json({
            ok: true,
            jobs: [{ id: 'job-b', queue: 'qb', state: 'waiting', createdAt: Date.now() }],
          })
        );
      }
      return Promise.resolve(json({ ok: false, error: `unexpected ${url}` }, 500));
    }) as typeof fetch;

    const { container, unmount } = render(createElement(MemoryRouter, {}, createElement(Jobs)));
    await settle(20);
    expect(oldSignals).toHaveLength(8);

    act(() => {
      useConnectionStore.setState({ baseUrl: 'http://server-b.test', token: 'bravo' });
    });
    await settle(30);
    expect(oldSignals.every((signal) => signal.aborted)).toBe(true);
    expect(listCalls.filter((call) => call.url.startsWith('http://srv/'))).toHaveLength(8);
    expect(
      listCalls
        .filter((call) => call.url.startsWith('http://srv/'))
        .every((call) => call.auth === 'Bearer alpha')
    ).toBe(true);
    expect(listCalls.filter((call) => call.url.startsWith('http://server-b.test/'))).toEqual([
      expect.objectContaining({ auth: 'Bearer bravo' }),
    ]);
    expect(container.textContent).toContain('Queried all 1 discovered queues');
    expect(container.textContent).toContain('job-b');
    unmount();
  });

  test('classic jobs never exposes cancel and cannot issue a job DELETE', async () => {
    let deletes = 0;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/dashboard/queues')) {
        return Promise.resolve(
          json({ ok: true, queues: [{ name: 'orders' }], total: 1, limit: 500, offset: 0 })
        );
      }
      if (url.endsWith('/dashboard')) {
        return Promise.resolve(
          json({
            ok: true,
            stats: {
              waiting: 1,
              active: 0,
              delayed: 0,
              totalCompleted: 0,
              totalFailed: 0,
            },
          })
        );
      }
      if (url.includes('/jobs/list')) {
        return Promise.resolve(
          json({
            ok: true,
            jobs: [{ id: 'job-1', queue: 'orders', state: 'waiting', createdAt: 1 }],
          })
        );
      }
      if (url.endsWith('/jobs/job-1') && init?.method === 'DELETE') {
        deletes += 1;
        return Promise.resolve(json({ ok: true }));
      }
      return Promise.resolve(json({ ok: false, error: `unexpected ${url}` }, 500));
    }) as typeof fetch;

    const { container, unmount } = render(createElement(MemoryRouter, {}, createElement(Jobs)));
    try {
      await settle(25);
      const cancel = container.querySelector<HTMLButtonElement>('button[aria-label="Cancel job"]');
      expect(cancel).toBeNull();
      expect(container.textContent).toContain('Delete unavailable');
      expect(deletes).toBe(0);
    } finally {
      unmount();
    }
  });
});
