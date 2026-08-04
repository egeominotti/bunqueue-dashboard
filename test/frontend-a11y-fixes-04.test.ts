import {
  createElement,
  DlqPro,
  describe,
  expect,
  installTestHooks,
  LogsPro,
  MemoryRouter,
  QueueDetailPro,
  Route,
  Routes,
  render,
  settle,
  test,
} from './frontend-a11y-fixes.helpers';

installTestHooks();

describe('honest async failures', () => {
  test('QueueDetailPro reports a failed recent-jobs fetch instead of an empty list', async () => {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/queues/summary')) {
        return Promise.resolve(
          Response.json([
            {
              name: 'orders',
              paused: false,
              counts: {
                waiting: 0,
                prioritized: 0,
                active: 0,
                completed: 1,
                failed: 0,
                delayed: 0,
              },
            },
          ])
        );
      }
      if (url.includes('/dashboard/queues/orders')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ok: true,
              name: 'orders',
              counts: {
                waiting: 0,
                prioritized: 0,
                active: 0,
                'waiting-children': 0,
                completed: 1,
                failed: 0,
                delayed: 0,
                paused: 0,
              },
              paused: false,
              priorityCounts: {},
              dlqPreview: [],
              timestamp: Date.now(),
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        );
      }
      if (url.includes('/jobs/list')) {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: false, error: 'job list unavailable' }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          })
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ ok: false, error: 'config unavailable' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        })
      );
    }) as typeof fetch;

    const { host, unmount } = render(
      createElement(
        MemoryRouter,
        { initialEntries: ['/queues/orders'] },
        createElement(
          Routes,
          {},
          createElement(Route, { path: '/queues/:name', element: createElement(QueueDetailPro) })
        )
      )
    );
    await settle(20);
    expect(host.textContent).toContain('Could not load recent jobs — job list unavailable');
    expect(host.textContent).not.toContain('No recent jobs.');
    unmount();
  });

  test('DLQ discovery failure never reports a healthy zero', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: false, error: 'discovery unavailable' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        })
      )) as typeof fetch;
    const { host, unmount } = render(createElement(MemoryRouter, {}, createElement(DlqPro)));
    await settle(20);
    expect(host.textContent).toContain('Health status is unavailable');
    expect(host.textContent).toContain('Unavailable');
    expect(host.textContent).not.toContain('Healthy');
    unmount();
  });

  test('a non-SSE activity response is shown as an error, not “Connecting” forever', async () => {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/events')) {
        return Promise.resolve(
          new Response(JSON.stringify({ login: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, queues: [], total: 0, limit: 500, offset: 0 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );
    }) as typeof fetch;
    const { host, unmount } = render(createElement(MemoryRouter, {}, createElement(LogsPro)));
    await settle(20);
    expect(host.textContent).toContain('Event stream unavailable');
    expect(host.textContent).toContain('expected text/event-stream');
    expect(host.textContent).not.toContain('Connecting to the event stream');
    unmount();
  });
});
