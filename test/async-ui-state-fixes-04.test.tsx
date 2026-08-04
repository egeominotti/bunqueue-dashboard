import {
  Cron,
  createElement,
  describe,
  expect,
  installTestHooks,
  Overview,
  type ReactElement,
  render,
  S3Backup,
  settle,
  test,
  useConnectionStore,
} from './async-ui-state-fixes.helpers';

installTestHooks();

describe('initial polling failures are not rendered as healthy or empty data', () => {
  const cases: Array<[string, () => ReactElement, string]> = [
    ['overview', () => createElement(Overview), 'StorageHealthy'],
    ['cron list', () => createElement(Cron), 'No scheduled jobs'],
    ['storage', () => createElement(S3Backup), 'DiskHealthy'],
  ];

  for (const [name, element, falseClaim] of cases) {
    test(`${name} shows an error state without a green Live badge or false claim`, async () => {
      globalThis.fetch = (() =>
        Promise.resolve(
          Response.json({ error: 'server unavailable' }, { status: 502 })
        )) as typeof fetch;
      const { host, unmount } = render(element());
      await settle(10);

      expect(host.textContent).toContain('Something went wrong');
      expect(host.textContent).toContain('server unavailable');
      expect(host.textContent?.replace(/\s+/g, '')).not.toContain(falseClaim);
      expect(Array.from(host.querySelectorAll('span')).some((s) => s.textContent === 'Live')).toBe(
        false
      );
      unmount();
    });
  }

  test('a failed refresh keeps the last overview but removes Live and labels it stale', async () => {
    useConnectionStore.setState({ refreshMs: 20 });
    let calls = 0;
    const snapshot = {
      ok: true,
      stats: {
        waiting: 7,
        active: 1,
        delayed: 0,
        completed: 2,
        dlq: 0,
        totalPushed: 10,
        totalPulled: 3,
        totalCompleted: 2,
        totalFailed: 0,
        uptime: 1000,
      },
      throughput: { pushPerSec: 1, pullPerSec: 1, completePerSec: 1, failPerSec: 0 },
      latency: { averages: {}, percentiles: {} },
      memory: { heapUsed: 1, heapTotal: 2, rss: 3 },
      collections: {},
      workers: { total: 0, active: 0, list: [], truncated: false },
      crons: { total: 0, list: [], truncated: false },
      storage: { diskFull: false },
      timestamp: 1,
    };
    globalThis.fetch = (() => {
      calls += 1;
      return Promise.resolve(
        calls === 1
          ? Response.json(snapshot)
          : Response.json({ error: 'refresh down' }, { status: 502 })
      );
    }) as typeof fetch;
    const { host, unmount } = render(createElement(Overview));
    await settle(10);
    expect(Array.from(host.querySelectorAll('span')).some((s) => s.textContent === 'Live')).toBe(
      true
    );
    expect(host.textContent).toContain('7');

    await settle(50);
    expect(host.textContent).toContain('last successful overview snapshot');
    expect(host.textContent).toContain('7');
    expect(Array.from(host.querySelectorAll('span')).some((s) => s.textContent === 'Live')).toBe(
      false
    );
    unmount();
  });
});
