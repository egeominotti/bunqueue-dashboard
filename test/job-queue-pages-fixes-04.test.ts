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
  setValue,
  test,
  useConnectionStore,
} from './job-queue-pages-fixes.helpers';

installTestHooks();

describe('JobLogs — a stale read must not undo a just-run mutation', () => {
  test('keeps path-safe opaque job punctuation byte-for-byte', async () => {
    const urls: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      urls.push(String(input));
      return Promise.resolve(json({ ok: true, data: { logs: [], count: 0 } }));
    }) as typeof fetch;
    const { unmount } = render(createElement(JobLogs, { jobId: 'job:@+' }));
    try {
      await settle(5);
      expect(urls).toEqual(['http://srv/jobs/job:@+/logs']);
    } finally {
      unmount();
    }
  });

  test('a 401 event identifies the exact server target and credential used', async () => {
    useConnectionStore.setState({
      baseUrl: 'https://logs-server.test/api',
      token: 'logs-token',
    });
    globalThis.fetch = (() =>
      Promise.resolve(json({ ok: false, error: 'unauthorized' }, 401))) as typeof fetch;
    const details: unknown[] = [];
    const onAuth = (event: Event) => details.push((event as CustomEvent).detail);
    window.addEventListener('auth:required', onAuth);
    const { container, unmount } = render(createElement(JobLogs, { jobId: 'j1' }));
    try {
      await settle(5);
      expect(container.textContent).toContain('unauthorized');
      expect(details).toEqual([
        {
          scope: 'server',
          auth: 'Bearer logs-token',
          target: 'https://logs-server.test/api',
        },
      ]);
    } finally {
      window.removeEventListener('auth:required', onAuth);
      unmount();
    }
  });

  test('an in-flight refresh started BEFORE the clear cannot resurrect the logs', async () => {
    const slow = deferred<Response>();
    let gets = 0;
    let deletes = 0;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'DELETE') {
        deletes += 1;
        return Promise.resolve(json({ ok: true }));
      }
      gets += 1;
      if (gets === 1) {
        return Promise.resolve(json({ ok: true, data: { logs: ['old line'], count: 1 } }));
      }
      if (gets === 2) return slow.promise; // Refresh — resolves LAST
      return Promise.resolve(json({ ok: true, data: { logs: [], count: 0 } })); // post-clear
    }) as typeof fetch;

    const originalConfirm = window.confirm;
    window.confirm = (() => true) as typeof window.confirm;
    const { container, unmount } = render(createElement(JobLogs, { jobId: 'j1' }));
    try {
      await settle(5);
      expect(container.textContent).toContain('old line');

      clickText(container, 'Refresh'); // read #2 starts, hangs
      await settle(2);
      const clear = [...container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('Clear logs')
      );
      if (!clear) throw new Error('Clear logs button not found');
      act(() => {
        clear.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        clear.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      }); // exactly one DELETE + read #3 (fast)
      await settle(5);
      expect(deletes).toBe(1);
      expect(container.textContent).not.toContain('old line');

      // The pre-DELETE snapshot lands now. Pre-fix it wrote last and the wiped
      // lines (and the count) reappeared with no error shown.
      await act(async () => {
        slow.resolve(json({ ok: true, data: { logs: ['old line'], count: 1 } }));
        await new Promise((r) => setTimeout(r, 5));
      });
      expect(container.textContent).not.toContain('old line');
    } finally {
      window.confirm = originalConfirm;
      unmount();
    }
  });

  test('a same-tick double Add sends one non-idempotent POST', async () => {
    const slowPost = deferred<Response>();
    const posts: Array<{ body: unknown; signal?: AbortSignal }> = [];
    let gets = 0;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'POST') {
        posts.push({
          body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
          signal: init?.signal,
        });
        return slowPost.promise;
      }
      gets += 1;
      return Promise.resolve(
        json({
          ok: true,
          data: gets === 1 ? { logs: [], count: 0 } : { logs: ['only once'], count: 1 },
        })
      );
    }) as typeof fetch;

    const { container, unmount } = render(createElement(JobLogs, { jobId: 'j1' }));
    try {
      await settle(5);
      const input = container.querySelector('input[aria-label="Log message"]') as HTMLInputElement;
      setValue(input, 'only once');
      expect(input.value).toBe('only once');
      const level = container.querySelector('select[aria-label="Log level"]') as HTMLSelectElement;
      const form = input.closest('form');
      if (!form) throw new Error('Log form not found');

      act(() => {
        Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set?.call(
          level,
          'warn'
        );
        // Keep React's render closure deliberately stale: the submit handler
        // must read the live form control values from this same browser task.
        form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
        form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      });
      expect(posts).toHaveLength(1);
      expect(posts[0]?.body).toEqual({ message: 'only once', level: 'warn' });

      slowPost.resolve(json({ ok: true }));
      await settle(10);
      expect(posts).toHaveLength(1);
      expect(container.textContent).toContain('only once');
      expect(input.value).toBe('');
    } finally {
      unmount();
    }
  });
});
