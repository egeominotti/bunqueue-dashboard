import {
  createElement,
  describe,
  expect,
  installTestHooks,
  Jobs,
  json,
  MAX_ALL_QUEUE_JOB_FANOUT,
  MemoryRouter,
  render,
  settle,
  test,
} from './job-queue-pages-fixes.helpers';

installTestHooks();

describe('Jobs classic — async failures and all-queue scope', () => {
  test('all queues means every discovered queue and reports per-queue list failures', async () => {
    const names = Array.from({ length: 26 }, (_, i) => `q${i + 1}`);
    let listCalls = 0;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/dashboard/queues')) {
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
            total: names.length,
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
            stats: {
              waiting: 0,
              active: 0,
              delayed: 0,
              completed: 1,
              dlq: 0,
              totalPushed: 1,
              totalPulled: 1,
              totalCompleted: 1,
              totalFailed: 0,
              uptime: 1,
            },
          })
        );
      }
      if (url.includes('/jobs/list')) {
        listCalls += 1;
        const queue = decodeURIComponent(url.match(/\/queues\/([^/]+)\/jobs\/list/)?.[1] ?? '');
        if (queue === 'q26') {
          return Promise.resolve(json({ ok: false, error: 'q26 list down' }, 503));
        }
        return Promise.resolve(
          json({
            ok: true,
            jobs:
              queue === 'q1'
                ? [{ id: 'job-q1', queue, state: 'waiting', createdAt: Date.now() }]
                : [],
          })
        );
      }
      return Promise.resolve(json({ ok: false, error: 'unexpected request' }, 500));
    }) as typeof fetch;

    const { container, unmount } = render(createElement(MemoryRouter, {}, createElement(Jobs)));
    await settle(40);
    const text = container.textContent ?? '';
    expect(listCalls).toBe(26);
    expect(text).toContain('Queried all 26 discovered queues');
    expect(text).toContain('Could not load jobs from 1 of 26 queues: q26 (q26 list down)');
    expect(text).toContain('job-q1');
    expect(text).not.toContain('No jobs found.');
    unmount();
  });

  test('blocks all-queue browsing before a large periodic job-list fan-out', async () => {
    const names = Array.from({ length: MAX_ALL_QUEUE_JOB_FANOUT + 1 }, (_, i) => `q${i + 1}`);
    let listCalls = 0;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/dashboard/queues')) {
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
            total: names.length,
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
      if (url.includes('/jobs/list')) listCalls += 1;
      return Promise.resolve(json({ ok: true, jobs: [] }));
    }) as typeof fetch;

    const { container, unmount } = render(createElement(MemoryRouter, {}, createElement(Jobs)));
    await settle(20);
    expect(listCalls).toBe(0);
    expect(container.textContent).toContain(
      `All-queue job browsing is limited to ${MAX_ALL_QUEUE_JOB_FANOUT} queues`
    );
    expect(
      [...container.querySelectorAll('span')].some((node) => node.textContent === 'Live')
    ).toBe(false);
    unmount();
  });
});
