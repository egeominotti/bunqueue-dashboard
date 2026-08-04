import {
  act,
  clickText,
  createElement,
  Diagnostics,
  deferred,
  describe,
  expect,
  installTestHooks,
  json,
  MetricsPro,
  render,
  settle,
  test,
} from './job-queue-pages-fixes.helpers';

installTestHooks();

describe('MetricsPro — sampler state is never presented as live zeroes', () => {
  test('shows connecting, then the sampler error, with unknown values and no Live badge', async () => {
    const dashboard = deferred<Response>();
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/queues/summary')) return Promise.resolve(json([]));
      if (url.endsWith('/stats')) {
        return Promise.resolve(
          json({
            ok: true,
            stats: {
              completed: 0,
              failed: 0,
              waiting: 0,
              prioritized: 0,
              active: 0,
              delayed: 0,
              'waiting-children': 0,
            },
          })
        );
      }
      if (url.endsWith('/dashboard')) return dashboard.promise;
      return Promise.resolve(json({ ok: false, error: 'unexpected request' }, 500));
    }) as typeof fetch;

    const { container, unmount } = render(createElement(MetricsPro));
    await settle(2);
    expect(container.textContent).toContain('Connecting live telemetry…');

    await act(async () => {
      dashboard.resolve(json({ ok: false, error: 'sampler down' }, 503));
      await new Promise((resolve) => setTimeout(resolve, 8));
    });
    const text = container.textContent ?? '';
    expect(text).toContain('Live telemetry unavailable — sampler down');
    const push = [...container.querySelectorAll('div')].find(
      (node) => node.textContent === 'Push/sec'
    )?.parentElement;
    expect(push?.textContent).toContain('—');
    expect(
      [...container.querySelectorAll('span')].some((node) => node.textContent === 'Live')
    ).toBe(false);
    expect(container.querySelector('[aria-label="throughput chart"]')).toBeNull();
    unmount();
  });
});

describe('Diagnostics — partial source failures stay explicit', () => {
  test('failed storage/stats never become Healthy, none, or zero totals', async () => {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/health')) {
        return Promise.resolve(
          json({
            ok: true,
            status: 'healthy',
            version: '2.8.55',
            uptime: 60,
            memory: { heapUsed: 1, heapTotal: 2, rss: 3 },
            connections: { tcp: 1, ws: 2, sse: 3 },
          })
        );
      }
      if (url.endsWith('/storage')) {
        return Promise.resolve(json({ ok: false, error: 'disk probe down' }, 500));
      }
      if (url.endsWith('/stats')) {
        return Promise.resolve(json({ ok: false, error: 'stats probe down' }, 500));
      }
      return Promise.resolve(json({ ok: false, error: 'unexpected request' }, 500));
    }) as typeof fetch;

    const { container, unmount } = render(createElement(Diagnostics));
    await settle(10);
    const text = container.textContent ?? '';
    expect(text).toContain('Storage diagnostics unavailable — disk probe down');
    expect(text).toContain('Server totals unavailable — stats probe down');
    const disk = [...container.querySelectorAll('div')].find(
      (node) => node.textContent === 'Disk'
    )?.parentElement;
    expect(disk?.textContent).toContain('Unavailable');
    expect(disk?.textContent).not.toContain('Healthy');
    expect(text).toContain('Storage errorunavailable — disk probe down');
    expect(text).not.toContain('Totals since restart');
    expect(
      [...container.querySelectorAll('span')].some((node) => node.textContent === 'Live')
    ).toBe(false);
    unmount();
  });
});

describe('Diagnostics — ping is last-to-START-wins', () => {
  test('a slow earlier probe does not overwrite the newer reading', async () => {
    const slow = deferred<Response>();
    let pings = 0;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/ping')) {
        pings += 1;
        if (pings === 1) return slow.promise;
        return Promise.resolve(json({ ok: true, data: { pong: true } }));
      }
      return Promise.resolve(json({ ok: true, data: {} }));
    }) as typeof fetch;

    const { container, unmount } = render(createElement(Diagnostics));
    await settle(5);

    clickText(container, 'Ping'); // probe 1 — hangs
    await settle(2);
    clickText(container, 'Ping'); // probe 2 — answers immediately
    await settle(5);
    const afterFast = container.textContent ?? '';
    expect(afterFast).toContain('Ping · ');
    expect(afterFast).not.toContain('unreachable');

    // Probe 1 finally fails. Pre-fix its write landed last and replaced the
    // newer, successful reading with 'unreachable'.
    await act(async () => {
      slow.resolve(json({ ok: false, error: 'down' }, 500));
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(container.textContent).not.toContain('unreachable');
    unmount();
  });
});
