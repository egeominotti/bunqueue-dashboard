import {
  act,
  clickText,
  createElement,
  deferred,
  describe,
  expect,
  installTestHooks,
  JobLogs,
  json,
  render,
  settle,
  test,
  useConnectionStore,
} from './job-queue-pages-fixes.helpers';

installTestHooks();

describe('JobLogs — a stale read must not undo a just-run mutation', () => {
  test('an old-target mutation cannot reload or publish into the new target', async () => {
    useConnectionStore.setState({ baseUrl: 'https://server-a.test/api', token: 'token-a' });
    const slowDelete = deferred<Response>();
    const calls: Array<{
      url: string;
      method: string;
      auth: string | null;
      signal?: AbortSignal;
    }> = [];
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const call = {
        url: String(input),
        method: init?.method ?? 'GET',
        auth: new Headers(init?.headers).get('Authorization'),
        signal: init?.signal,
      };
      calls.push(call);
      if (call.method === 'DELETE' && call.url.startsWith('https://server-a.test')) {
        return slowDelete.promise; // deliberately ignores abort
      }
      if (call.method === 'GET' && call.url.startsWith('https://server-a.test')) {
        return Promise.resolve(json({ ok: true, data: { logs: ['server-a'], count: 1 } }));
      }
      if (call.method === 'GET' && call.url.startsWith('https://server-b.test')) {
        return Promise.resolve(json({ ok: true, data: { logs: ['server-b'], count: 1 } }));
      }
      return Promise.resolve(json({ ok: false, error: `unexpected request: ${call.url}` }, 500));
    }) as typeof fetch;

    const originalConfirm = window.confirm;
    window.confirm = (() => true) as typeof window.confirm;
    const { container, unmount } = render(createElement(JobLogs, { jobId: 'shared-job' }));
    try {
      await settle(5);
      expect(container.textContent).toContain('server-a');
      clickText(container, 'Clear logs');
      const oldDelete = calls.find((call) => call.method === 'DELETE');
      expect(oldDelete?.signal?.aborted).toBeFalse();

      act(() =>
        useConnectionStore.setState({
          baseUrl: 'https://server-b.test/api',
          token: 'token-b',
        })
      );
      expect(oldDelete?.signal?.aborted).toBeTrue();
      await settle(10);
      expect(container.textContent).toContain('server-b');
      expect(container.textContent).not.toContain('server-a');

      slowDelete.resolve(json({ ok: true }));
      await settle(10);
      expect(container.textContent).toContain('server-b');
      expect(
        calls.filter(
          (call) => call.method === 'GET' && call.url.startsWith('https://server-a.test')
        )
      ).toHaveLength(1);
      expect(
        calls.map((call) => ({
          url: call.url,
          auth: call.auth,
        }))
      ).toEqual([
        {
          url: 'https://server-a.test/api/jobs/shared-job/logs',
          auth: 'Bearer token-a',
        },
        {
          url: 'https://server-a.test/api/jobs/shared-job/logs',
          auth: 'Bearer token-a',
        },
        {
          url: 'https://server-b.test/api/jobs/shared-job/logs',
          auth: 'Bearer token-b',
        },
      ]);
    } finally {
      window.confirm = originalConfirm;
      unmount();
    }
  });

  test('a failed read-back states that the clear already succeeded', async () => {
    let gets = 0;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'DELETE') return Promise.resolve(json({ ok: true }));
      gets += 1;
      if (gets === 1) {
        return Promise.resolve(json({ ok: true, data: { logs: ['old line'], count: 1 } }));
      }
      return Promise.resolve(json({ ok: false, error: 'reload down' }, 502));
    }) as typeof fetch;

    const originalConfirm = window.confirm;
    window.confirm = (() => true) as typeof window.confirm;
    const { container, unmount } = render(createElement(JobLogs, { jobId: 'j1' }));
    try {
      await settle(5);
      clickText(container, 'Clear logs');
      await settle(10);
      expect(container.textContent).toContain(
        "Log clearing succeeded, but couldn't reload logs: reload down"
      );
      expect(container.textContent).not.toContain('old line');
    } finally {
      window.confirm = originalConfirm;
      unmount();
    }
  });

  test('unmount aborts a pending load even when fetch resolves late', async () => {
    const slow = deferred<Response>();
    let signal: AbortSignal | undefined;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal;
      return slow.promise;
    }) as typeof fetch;

    const { container, unmount } = render(createElement(JobLogs, { jobId: 'j1' }));
    expect(signal).toBeDefined();
    unmount();
    expect(signal?.aborted).toBeTrue();
    slow.resolve(json({ ok: true, data: { logs: ['late'], count: 1 } }));
    await settle(5);
    expect(container.textContent).toBe('');
  });
});
