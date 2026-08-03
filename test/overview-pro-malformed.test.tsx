import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { assertRenderableOverview, OverviewPro } from '../src/pages/control/OverviewPro';
import { ensureDom, settle } from './domSetup';

const realFetch = globalThis.fetch;

const compatibleSnapshot = {
  ok: true,
  stats: {
    waiting: 37,
    active: 2,
    completed: 11,
    dlq: 0,
    totalPushed: 50,
    totalPulled: 13,
    uptime: 1_000,
  },
  throughput: { pushPerSec: 1.5, pullPerSec: 0.5 },
  memory: { rss: 32 },
  crons: { total: 0 },
};

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

function renderOverview() {
  return render(createElement(MemoryRouter, null, createElement(OverviewPro)));
}

beforeEach(() => {
  ensureDom();
  useConnectionStore.setState({
    baseUrl: 'http://server.test',
    token: '',
    agentToken: '',
    refreshMs: 3_000,
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  useConnectionStore.setState({
    baseUrl: '/api',
    token: '',
    agentToken: '',
    refreshMs: 3_000,
  });
});

describe('OverviewPro malformed /dashboard responses', () => {
  test('accepts the v2.8.55 fields the page actually renders', () => {
    expect(() => assertRenderableOverview(compatibleSnapshot)).not.toThrow();
  });

  test('turns an incomplete HTTP 200 body into a readable error state', async () => {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/dashboard')) {
        return Promise.resolve(Response.json({ ok: true }));
      }
      if (url.endsWith('/queues/summary')) {
        return Promise.resolve(
          Response.json([
            {
              name: 'orders',
              paused: false,
              counts: {
                waiting: 30,
                prioritized: 7,
                active: 2,
                completed: 11,
                failed: 0,
                delayed: 0,
              },
            },
          ])
        );
      }
      return Promise.resolve(Response.json({ error: 'unexpected request' }, { status: 500 }));
    }) as typeof fetch;

    const { host, unmount } = renderOverview();
    await settle(20);

    expect(host.textContent).toContain('Real-time system health is unavailable.');
    expect(host.textContent).toContain('Something went wrong');
    expect(host.textContent).toContain('Malformed /dashboard response');
    expect(host.textContent).not.toContain('bunqueue server connected');
    unmount();
  });

  test('keeps the last valid snapshot stale when a later HTTP 200 body is malformed', async () => {
    useConnectionStore.setState({ refreshMs: 20 });
    let dashboardCalls = 0;
    let finishMalformedResponse: ((response: Response) => void) | undefined;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/dashboard')) {
        dashboardCalls += 1;
        if (dashboardCalls === 1) return Promise.resolve(Response.json(compatibleSnapshot));
        return new Promise<Response>((resolve) => {
          finishMalformedResponse = resolve;
        });
      }
      if (url.endsWith('/queues/summary')) {
        return Promise.resolve(
          Response.json([
            {
              name: 'orders',
              paused: false,
              counts: {
                waiting: 30,
                prioritized: 7,
                active: 2,
                completed: 11,
                failed: 0,
                delayed: 0,
              },
            },
          ])
        );
      }
      if (url.includes('/events')) {
        return Promise.resolve(Response.json({ error: 'stream unavailable' }, { status: 404 }));
      }
      return Promise.resolve(Response.json({ error: 'unexpected request' }, { status: 500 }));
    }) as typeof fetch;

    const { host, unmount } = renderOverview();
    await settle(30);
    expect(host.textContent).toContain('bunqueue server connected');
    expect(host.textContent).toContain('37');
    expect(finishMalformedResponse).toBeDefined();

    await act(async () => {
      finishMalformedResponse?.(Response.json({ ok: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(host.textContent).toContain('showing the last successful overview snapshot');
    expect(host.textContent).toContain('Connection lost — showing last known data');
    expect(host.textContent).toContain('37');
    expect(host.textContent).not.toContain('bunqueue server connected');
    unmount();
  });
});
