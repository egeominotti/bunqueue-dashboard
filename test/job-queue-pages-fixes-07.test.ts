import {
  createElement,
  describe,
  discoverAllQueues,
  expect,
  installTestHooks,
  Jobs,
  jobDataName,
  json,
  MemoryRouter,
  render,
  settle,
  test,
} from './job-queue-pages-fixes.helpers';

installTestHooks();

describe('Jobs classic — async failures and all-queue scope', () => {
  test('treats non-string data.name as unnamed and never calls string methods on it', () => {
    expect(jobDataName({ name: 123 })).toBeNull();
    expect(jobDataName({ name: { nested: true } })).toBeNull();
    expect(jobDataName({ name: 'report' })).toBe('report');
  });

  test('rejects overlapping queue pages instead of silently omitting queues', async () => {
    let calls = 0;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const offset = Number(url.searchParams.get('offset'));
      calls += 1;
      const names =
        offset === 0 ? Array.from({ length: 500 }, (_, index) => `q${index}`) : ['q499'];
      return Promise.resolve(
        json({
          ok: true,
          queues: names.map((name) => ({
            name,
            waiting: 0,
            delayed: 0,
            active: 0,
            dlq: 0,
            paused: false,
          })),
          total: 501,
          limit: 500,
          offset,
          timestamp: Date.now(),
        })
      );
    }) as typeof fetch;

    await expect(discoverAllQueues()).rejects.toThrow('pages overlap at queue q499');
    expect(calls).toBe(2);
  });

  test('rejects premature short pages and totals that change during discovery', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        json({ ok: true, queues: [{ name: 'q1' }], total: 2, limit: 500, offset: 0 })
      )) as typeof fetch;
    await expect(discoverAllQueues()).rejects.toThrow('malformed or unsafe page');

    let calls = 0;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const offset = Number(new URL(String(input)).searchParams.get('offset'));
      calls += 1;
      const total = offset === 0 ? 501 : 502;
      const names =
        offset === 0 ? Array.from({ length: 500 }, (_, index) => `q${index}`) : ['q500', 'q501'];
      return Promise.resolve(
        json({
          ok: true,
          queues: names.map((name) => ({ name })),
          total,
          limit: 500,
          offset,
        })
      );
    }) as typeof fetch;
    await expect(discoverAllQueues()).rejects.toThrow('malformed or unsafe page');
    expect(calls).toBe(2);
  });

  test('rejects hostile totals before starting an unbounded discovery fan-out', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        json({
          ok: true,
          queues: [],
          total: Number.MAX_SAFE_INTEGER,
          limit: 500,
          offset: 0,
          timestamp: Date.now(),
        })
      )) as typeof fetch;

    await expect(discoverAllQueues()).rejects.toThrow('malformed or unsafe page');
  });

  test('queue discovery and overview failures are visible, never a factual empty/zero view', async () => {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/dashboard/queues')) {
        return Promise.resolve(json({ ok: false, error: 'discovery down' }, 503));
      }
      if (url.endsWith('/dashboard')) {
        return Promise.resolve(json({ ok: false, error: 'overview down' }, 503));
      }
      return Promise.resolve(json({ ok: false, error: 'unexpected request' }, 500));
    }) as typeof fetch;

    const { container, unmount } = render(createElement(MemoryRouter, {}, createElement(Jobs)));
    await settle(12);
    const text = container.textContent ?? '';
    expect(text).toContain('Queue discovery unavailable — discovery down');
    expect(text).toContain('Job totals unavailable — overview down');
    expect(text).not.toContain('No jobs found.');
    const total = [...container.querySelectorAll('div')].find(
      (node) => node.textContent === 'Total'
    )?.parentElement;
    expect(total?.textContent).toContain('—');
    expect(
      [...container.querySelectorAll('span')].some((node) => node.textContent === 'Live')
    ).toBe(false);
    unmount();
  });
});
