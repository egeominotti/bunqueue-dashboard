import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { api } from '../src/lib/api';
import { Diagnostics } from '../src/pages/control/Diagnostics';
import { ensureDom, settle } from './domSetup';

ensureDom();

const realFetch = globalThis.fetch;
const mounted = new Set<() => void>();

function renderDiagnostics() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const unmount = () => {
    act(() => root.unmount());
    host.remove();
    mounted.delete(unmount);
  };
  mounted.add(unmount);
  act(() => root.render(createElement(Diagnostics)));
  return host;
}

beforeEach(() => {
  useConnectionStore.setState({
    baseUrl: 'http://server.test',
    token: 'secret',
    agentToken: '',
    refreshMs: 60_000,
  });
});

afterEach(() => {
  for (const unmount of [...mounted]) unmount();
  globalThis.fetch = realFetch;
  useConnectionStore.setState({ baseUrl: '/api', token: '', agentToken: '', refreshMs: 3000 });
});

describe('Bunqueue 2.9.2 diagnostic endpoint client', () => {
  test('preserves plaintext liveness and structured readiness/metrics contracts', async () => {
    const calls: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      calls.push(path);
      if (path === '/healthz' || path === '/live') return Promise.resolve(new Response('OK'));
      if (path === '/ready') {
        return Promise.resolve(
          Response.json(
            {
              ok: false,
              ready: false,
              storage: { diskFull: true, error: 'ENOSPC', since: 1_700_000_000_000 },
            },
            { status: 503 }
          )
        );
      }
      return Promise.resolve(
        Response.json({
          ok: true,
          metrics: {
            totalPushed: 21,
            totalPulled: 18,
            totalCompleted: 17,
            totalFailed: 1,
          },
        })
      );
    }) as typeof fetch;

    const [healthz, live, ready, metrics] = await Promise.all([
      api.healthz(),
      api.live(),
      api.ready(),
      api.metrics(),
    ]);

    expect(healthz).toBe('OK');
    expect(live).toBe('OK');
    expect(ready).toEqual({
      ok: false,
      ready: false,
      storage: { diskFull: true, error: 'ENOSPC', since: 1_700_000_000_000 },
    });
    expect(metrics.metrics).toEqual({
      totalPushed: 21,
      totalPulled: 18,
      totalCompleted: 17,
      totalFailed: 1,
    });
    expect(calls).toEqual(['/healthz', '/live', '/ready', '/metrics']);
  });
});

describe('Diagnostics endpoint UI', () => {
  test('shows exact probe states, degraded readiness, and JSON counters', async () => {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === '/healthz') return Promise.resolve(new Response('OK'));
      if (path === '/live') return Promise.resolve(new Response('<html>fallback</html>'));
      if (path === '/ready') {
        return Promise.resolve(
          Response.json(
            {
              ok: false,
              ready: false,
              storage: { diskFull: true, error: 'ENOSPC', since: 42 },
            },
            { status: 503 }
          )
        );
      }
      if (path === '/metrics') {
        return Promise.resolve(
          Response.json({
            ok: true,
            metrics: {
              totalPushed: 34,
              totalPulled: 8,
              totalCompleted: 4,
              totalFailed: 2,
            },
          })
        );
      }
      if (path === '/health') {
        return Promise.resolve(
          Response.json(
            {
              ok: false,
              status: 'degraded',
              version: '2.9.2',
              uptime: 120,
              memory: { heapUsed: 3, heapTotal: 4, rss: 68 },
              connections: { tcp: 1, ws: 0, sse: 0 },
            },
            { status: 503 }
          )
        );
      }
      if (path === '/storage') {
        return Promise.resolve(
          Response.json({ ok: false, data: { diskFull: true, error: 'ENOSPC', since: 42 } })
        );
      }
      if (path === '/stats') {
        return Promise.resolve(
          Response.json({
            ok: true,
            stats: {
              totalPushed: 34,
              totalPulled: 8,
              totalCompleted: 4,
              totalFailed: 2,
            },
          })
        );
      }
      throw new Error(`Unexpected request: ${path}`);
    }) as typeof fetch;

    const host = renderDiagnostics();
    await settle(20);

    expect(host.textContent).toContain('Orchestrator probes');
    expect(host.textContent).toContain('/healthzLiveHTTP 200 · OK');
    expect(host.textContent).toContain('/liveUnexpected');
    expect(host.textContent).toContain('/readyNot readyENOSPC');
    expect(host.textContent).toContain('JSON metrics');
    expect(host.textContent).toContain('GET /metrics · application/json');
    expect(host.textContent).toContain('34');
  });
});
