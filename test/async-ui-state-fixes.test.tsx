import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { useAlertsStore } from '../src/components/dashboard/stores/alertsStore';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { ConnectionBadge } from '../src/components/layout/ConnectionBadge';
import { useActivityStream } from '../src/lib/useActivityStream';
import { alertConnectionIdentity, useAlertRuntimeStore } from '../src/lib/useAlertEngine';
import { Alerts } from '../src/pages/Alerts';
import { Cron } from '../src/pages/Cron';
import { DlqControl } from '../src/pages/control/DlqControl';
import { JobsPro } from '../src/pages/control/JobsPro';
import { ProcessLogs } from '../src/pages/control/server/ProcessLogs';
import { UsagePro } from '../src/pages/control/UsagePro';
import { Dlq } from '../src/pages/Dlq';
import { Overview } from '../src/pages/Overview';
import { S3Backup } from '../src/pages/S3Backup';
import { ensureDom, renderHook, settle } from './domSetup';

const realFetch = globalThis.fetch;

function render(element: ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(element));
  return {
    host,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

beforeEach(() => {
  ensureDom();
  useConnectionStore.setState({
    baseUrl: 'http://server.test',
    token: '',
    agentToken: '',
    refreshMs: 3000,
  });
  useAlertsStore.setState({ rules: [] });
  useAlertRuntimeStore.setState({
    breaching: [],
    status: 'idle',
    error: null,
    connectionIdentity: null,
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  useConnectionStore.setState({ baseUrl: '/api', token: '', agentToken: '', refreshMs: 3000 });
  useAlertsStore.setState({ rules: [] });
});

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

describe('activity-stream target changes', () => {
  test('switching queue clears the previous queue throughput immediately', async () => {
    const encoder = new TextEncoder();
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controllers.push(controller);
              init?.signal?.addEventListener(
                'abort',
                () =>
                  controller.error(
                    init.signal?.reason ?? new DOMException('Aborted', 'AbortError')
                  ),
                { once: true }
              );
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } }
        )
      )) as typeof fetch;

    const renders: Array<ReturnType<typeof useActivityStream>> = [];
    const hook = renderHook((queue: string) => {
      const snapshot = useActivityStream(queue);
      renders.push({
        ...snapshot,
        events: [...snapshot.events],
        counters: { ...snapshot.counters },
      });
      return snapshot;
    }, 'queue-a');
    await settle(20);
    controllers[0]?.enqueue(
      encoder.encode('event: job:pushed\ndata: {"queue":"queue-a","jobId":"a"}\n\n')
    );
    await settle(1100);
    expect(hook.result.current.throughput).toBeGreaterThan(0);
    expect(hook.result.current.events).toHaveLength(1);
    expect(hook.result.current.counters.total).toBe(1);
    expect(hook.result.current.connected).toBe(true);

    controllers[0]?.error(new Error('old target stream failed'));
    await settle(20);
    expect(hook.result.current.error?.message).toContain('old target stream failed');

    const firstQueueBRender = renders.length;
    hook.rerender('queue-b');
    const transitional = renders[firstQueueBRender];
    expect(transitional).toBeDefined();
    expect(transitional.throughput).toBe(0);
    expect(transitional.events).toEqual([]);
    expect(transitional.counters).toEqual({
      total: 0,
      completed: 0,
      failed: 0,
      waiting: 0,
      active: 0,
    });
    expect(transitional.connected).toBe(false);
    expect(transitional.error).toBeNull();
    await settle(10);
    hook.unmount();
  }, 10000);
});

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

  test('a structurally incomplete storage response is unavailable, never Healthy', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(Response.json({ ok: true, data: {} }))) as typeof fetch;
    const { host, unmount } = render(createElement(S3Backup));
    await settle(10);

    expect(host.textContent).toContain('missing disk health data');
    expect(host.textContent).not.toContain('Healthy');
    expect(Array.from(host.querySelectorAll('span')).some((s) => s.textContent === 'Live')).toBe(
      false
    );
    unmount();
  });

  test('overview storage with unknown disk health is not presented as Healthy or Live', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        Response.json({
          ok: true,
          stats: {
            waiting: 0,
            active: 0,
            delayed: 0,
            completed: 0,
            dlq: 0,
            totalPushed: 0,
            totalPulled: 0,
            totalCompleted: 0,
            totalFailed: 0,
            uptime: 1000,
          },
          throughput: { pushPerSec: 0, pullPerSec: 0, completePerSec: 0, failPerSec: 0 },
          latency: { averages: {}, percentiles: {} },
          memory: { heapUsed: 1, heapTotal: 2, rss: 3 },
          collections: {},
          workers: { total: 0, active: 0, list: [], truncated: false },
          crons: { total: 0, list: [], truncated: false },
          storage: {},
          timestamp: 1,
        })
      )) as typeof fetch;
    const { host, unmount } = render(createElement(Overview));
    await settle(10);

    expect(host.textContent).toContain('Unavailable');
    expect(host.textContent?.replace(/\s+/g, '')).not.toContain('StorageHealthy');
    expect(Array.from(host.querySelectorAll('span')).some((s) => s.textContent === 'Live')).toBe(
      false
    );
    unmount();
  });

  test('the pro usage page also rejects missing disk-health data', async () => {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/storage')) return Promise.resolve(Response.json({ ok: true, data: {} }));
      if (url.endsWith('/queues/summary')) return Promise.resolve(Response.json([]));
      return Promise.resolve(Response.json({ ok: true }));
    }) as typeof fetch;
    const { host, unmount } = render(createElement(UsagePro));
    await settle(10);

    expect(host.textContent).toContain('missing disk health data');
    expect(host.textContent).not.toContain('Disk writes are being accepted');
    unmount();
  });

  test('DLQ discovery keeps totals unknown instead of publishing a synthetic zero', async () => {
    let finishDiscovery!: (response: Response) => void;
    globalThis.fetch = (() =>
      new Promise<Response>((resolve) => {
        finishDiscovery = resolve;
      })) as typeof fetch;
    const { host, unmount } = render(createElement(Dlq));
    await settle(10);

    expect(host.textContent).toContain('Discovering queues');
    expect(host.textContent?.replace(/\s+/g, '')).not.toContain('DLQEntries0');
    finishDiscovery(Response.json({ ok: true, queues: [], total: 0 }));
    await settle(10);
    unmount();
  });

  test('JobsPro does not claim Live or an empty job page while queue discovery is pending', async () => {
    let finishDiscovery!: (response: Response) => void;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      if (String(input).endsWith('/queues/summary')) {
        return new Promise<Response>((resolve) => {
          finishDiscovery = resolve;
        });
      }
      return Promise.resolve(
        Response.json({
          ok: true,
          stats: { completed: 0, waiting: 0, active: 0, delayed: 0 },
        })
      );
    }) as typeof fetch;
    const { host, unmount } = render(
      createElement(MemoryRouter, { initialEntries: ['/jobs'] }, createElement(JobsPro))
    );
    await settle(10);

    expect(host.textContent).toContain('Discovering queues');
    expect(host.textContent).not.toContain('No jobs found');
    expect(Array.from(host.querySelectorAll('span')).some((s) => s.textContent === 'Live')).toBe(
      false
    );
    finishDiscovery(Response.json([]));
    await settle(10);
    unmount();
  });

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
