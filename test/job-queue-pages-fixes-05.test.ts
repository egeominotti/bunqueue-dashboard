import {
  act,
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
} from './job-queue-pages-fixes.helpers';

installTestHooks();

describe('JobLogs — a stale read must not undo a just-run mutation', () => {
  test('an accepted Add preserves a newer draft typed while its POST is pending', async () => {
    const slowPost = deferred<Response>();
    const posts: unknown[] = [];
    let gets = 0;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST') {
        posts.push(typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body);
        return slowPost.promise;
      }
      gets += 1;
      return Promise.resolve(
        json({
          ok: true,
          data: gets === 1 ? { logs: [], count: 0 } : { logs: ['first draft'], count: 1 },
        })
      );
    }) as typeof fetch;

    const { container, unmount } = render(createElement(JobLogs, { jobId: 'j1' }));
    try {
      await settle(5);
      const input = container.querySelector('input[aria-label="Log message"]') as HTMLInputElement;
      const form = input.closest('form');
      if (!form) throw new Error('Log form not found');

      setValue(input, 'first draft');
      act(() => {
        form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      });
      expect(posts).toEqual([{ message: 'first draft', level: 'info' }]);

      setValue(input, 'second draft');
      expect(input.value).toBe('second draft');

      slowPost.resolve(json({ ok: true }));
      await settle(10);

      expect(posts).toHaveLength(1);
      expect(container.textContent).toContain('first draft');
      expect(input.value).toBe('second draft');
    } finally {
      unmount();
    }
  });

  test('an accepted Add preserves the message when only its draft level changed', async () => {
    const slowPost = deferred<Response>();
    const posts: unknown[] = [];
    let gets = 0;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST') {
        posts.push(typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body);
        return slowPost.promise;
      }
      gets += 1;
      return Promise.resolve(
        json({
          ok: true,
          data: gets === 1 ? { logs: [], count: 0 } : { logs: ['same text'], count: 1 },
        })
      );
    }) as typeof fetch;

    const { container, unmount } = render(createElement(JobLogs, { jobId: 'j1' }));
    try {
      await settle(5);
      const input = container.querySelector('input[aria-label="Log message"]') as HTMLInputElement;
      const level = container.querySelector('select[aria-label="Log level"]') as HTMLSelectElement;
      const form = input.closest('form');
      if (!form) throw new Error('Log form not found');

      setValue(input, 'same text');
      act(() => {
        form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      });
      expect(posts).toEqual([{ message: 'same text', level: 'info' }]);
      setValue(level, 'error');

      slowPost.resolve(json({ ok: true }));
      await settle(10);

      expect(posts).toHaveLength(1);
      expect(input.value).toBe('same text');
      expect(level.value).toBe('error');
    } finally {
      unmount();
    }
  });

  test('a malformed 2xx mutation is an error and never triggers an authoritative reload', async () => {
    let gets = 0;
    let posts = 0;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST') {
        posts += 1;
        return Promise.resolve(json({ accepted: true }));
      }
      gets += 1;
      return Promise.resolve(json({ ok: true, data: { logs: [], count: 0 } }));
    }) as typeof fetch;

    const { container, unmount } = render(createElement(JobLogs, { jobId: 'j1' }));
    try {
      await settle(5);
      const input = container.querySelector('input[aria-label="Log message"]') as HTMLInputElement;
      setValue(input, 'must be acknowledged');
      const form = input.closest('form');
      if (!form) throw new Error('Log form not found');
      act(() => {
        form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      });
      await settle(5);

      expect(posts).toBe(1);
      expect(gets).toBe(1);
      expect(container.textContent).toContain(
        'Invalid log mutation response: expected { ok: true }'
      );
      expect(input.value).toBe('must be acknowledged');
    } finally {
      unmount();
    }
  });
});
