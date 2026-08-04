import {
  Alerts,
  alertConnectionIdentity,
  ConnectionBadge,
  createElement,
  DlqControl,
  describe,
  expect,
  installTestHooks,
  ProcessLogs,
  render,
  settle,
  test,
  useAlertRuntimeStore,
  useAlertsStore,
} from './async-ui-state-fixes.helpers';

installTestHooks();

describe('honest connection and process-log states', () => {
  test('health HTTP 503 is reachable-but-degraded, not offline', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        Response.json({ ok: false, status: 'degraded' }, { status: 503 })
      )) as typeof fetch;
    const { host, unmount } = render(createElement(ConnectionBadge));
    await settle(10);

    expect(host.textContent).toContain('reachable, degraded');
    expect(host.querySelector('[title="reachable, degraded"]')).not.toBeNull();
    expect(host.textContent).not.toContain('offline');
    unmount();
  });

  test('an unreachable health endpoint is reported offline', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(Response.json({ error: 'down' }, { status: 502 }))) as typeof fetch;
    const { host, unmount } = render(createElement(ConnectionBadge));
    await settle(10);

    expect(host.textContent).toContain('offline');
    expect(host.querySelector('[title="offline"]')).not.toBeNull();
    unmount();
  });

  test('a process-log request failure never masquerades as an empty log', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        Response.json({ error: 'agent unavailable' }, { status: 502 })
      )) as typeof fetch;
    const { host, unmount } = render(createElement(ProcessLogs));
    await settle(10);

    expect(host.textContent).toContain('Something went wrong');
    expect(host.textContent).toContain('agent unavailable');
    expect(host.textContent).toContain('logs unavailable');
    expect(host.textContent).not.toContain('No output yet.');
    expect(Array.from(host.querySelectorAll('button')).some((b) => b.textContent === 'Retry')).toBe(
      true
    );
    unmount();
  });

  test('a partial DLQ stats failure keeps the entry list but removes Live', async () => {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/dashboard/queues?')) {
        return Promise.resolve(
          Response.json({
            ok: true,
            queues: [{ name: 'email', dlq: 0, waiting: 0, active: 0, delayed: 0, paused: false }],
            total: 1,
            limit: 500,
            offset: 0,
            timestamp: Date.now(),
          })
        );
      }
      if (url.includes('/dlq/stats')) {
        return Promise.resolve(Response.json({ error: 'stats backend down' }, { status: 502 }));
      }
      if (url.includes('/dlq?')) {
        return Promise.resolve(Response.json({ ok: true, entries: [], total: 0 }));
      }
      return Promise.resolve(Response.json({ error: 'unexpected request' }, { status: 500 }));
    }) as typeof fetch;
    const { host, unmount } = render(createElement(DlqControl));
    await settle(50);

    expect(host.textContent).toContain('DLQ statistics are unavailable');
    expect(host.textContent).toContain('stats backend down');
    expect(Array.from(host.querySelectorAll('span')).some((s) => s.textContent === 'Live')).toBe(
      false
    );
    unmount();
  });

  test('Alerts only claims Live for enabled rules with a current successful evaluation', () => {
    const identity = alertConnectionIdentity('http://server.test', '');
    useAlertRuntimeStore.setState({
      breaching: [],
      status: 'live',
      error: null,
      connectionIdentity: identity,
    });
    const idle = render(createElement(Alerts));
    expect(
      Array.from(idle.host.querySelectorAll('span')).some((s) => s.textContent === 'Live')
    ).toBe(false);
    idle.unmount();

    useAlertsStore.setState({
      rules: [
        {
          id: 'waiting',
          name: 'Waiting jobs',
          metric: 'waiting',
          operator: '>=',
          threshold: 10,
          queue: '',
          channel: 'email',
          enabled: true,
        },
      ],
    });
    useAlertRuntimeStore.setState({
      status: 'degraded',
      error: 'Alert metrics are unavailable',
      connectionIdentity: identity,
    });
    const degraded = render(createElement(Alerts));
    expect(degraded.host.textContent).toContain('Alert metrics are unavailable');
    expect(degraded.host.textContent).not.toContain(
      'All enabled rules are within their thresholds'
    );
    expect(
      Array.from(degraded.host.querySelectorAll('span')).some((s) => s.textContent === 'Live')
    ).toBe(false);
    degraded.unmount();
  });
});
