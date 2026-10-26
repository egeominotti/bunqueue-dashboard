import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { MetricHistory } from '../src/features/metric-history/MetricHistory';
import { ensureDom, settle } from './domSetup';

const realFetch = globalThis.fetch;
let originalConnection: ReturnType<typeof useConnectionStore.getState>;
const mounted = new Set<() => void>();

beforeEach(() => {
  ensureDom();
  originalConnection = useConnectionStore.getState();
  useConnectionStore.setState({
    baseUrl: 'http://queue.test',
    agentBaseUrl: 'http://agent.test',
    token: '',
    agentToken: '',
  });
});
afterEach(() => {
  for (const unmount of mounted) unmount();
  mounted.clear();
  globalThis.fetch = realFetch;
  useConnectionStore.setState(originalConnection, true);
});

describe('native metric history screen', () => {
  test('renders observed window totals, independent coverage and bounded selectors', async () => {
    const requests: URL[] = [];
    const anchor = Math.floor(Date.now() / 60000) * 60000;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      requests.push(url);
      const completed = url.searchParams.get('type') === 'completed';
      return Response.json({
        ok: true,
        metrics: {
          meta: {
            count: completed ? 99999 : 88888,
            prevTS: anchor - (completed ? 0 : 60000) + 123,
            prevCount: completed ? 5 : 2,
          },
          data: completed ? [5, 2] : [2],
          count: completed ? 1000 : 1,
        },
      });
    }) as typeof fetch;
    const host = render('orders');
    await settle(5);
    expect(host.textContent).toContain('Native metric history');
    expect(host.querySelector('[data-summary="completed"]')?.textContent).toContain(
      'Observed window total: 7'
    );
    expect(host.querySelector('[data-summary="completed"]')?.textContent).toContain(
      '2 / 60 minutes'
    );
    expect(host.querySelector('[data-summary="failed"]')?.textContent).toContain('1 / 60 minutes');
    expect(host.textContent).toContain('Lifetime terminal: 99999');
    expect(host.textContent).toContain('1000 available');
    expect(host.textContent).toContain('Unknown time is left blank');
    expect(host.querySelector('svg[role="img"]')).not.toBeNull();
    const failurePath = host.querySelector('path[data-metric="failed"]')?.getAttribute('d');
    expect(failurePath).toBeTruthy();
    expect(failurePath).not.toContain('1000,');
    click(host, '24h');
    await settle(5);
    expect(requests.slice(-2).every((url) => url.searchParams.get('end') === '1439')).toBe(true);
    click(host, '7d');
    await settle(5);
    expect(requests).toHaveLength(6);
    expect(requests.slice(-2).every((url) => url.searchParams.get('end') === '10079')).toBe(true);
    click(host, 'Refresh');
    await settle(5);
    expect(requests).toHaveLength(8);
  });

  test('discloses empty and unretained history with zero known coverage', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const completed = new URL(String(input)).searchParams.get('type') === 'completed';
      return Response.json({
        ok: true,
        metrics: {
          meta: { count: completed ? 0 : 15, prevTS: completed ? 0 : Date.now(), prevCount: 0 },
          data: [],
          count: 0,
        },
      });
    }) as typeof fetch;
    const host = render('orders');
    await settle(5);
    expect(host.textContent).toContain('No terminal events recorded');
    expect(host.textContent).toContain(
      'No retained buckets; retention may be disabled or history unavailable'
    );
    expect(host.textContent).toContain('0 / 60 minutes');
    expect(host.querySelector('path[data-metric="completed"]')?.getAttribute('d')).toBe('');
  });

  test('renders partial failures and distinguishes unavailable from successful empty reads', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (new URL(String(input)).searchParams.get('type') === 'failed') {
        return Response.json({ ok: false, error: 'Agent target mismatch' }, { status: 409 });
      }
      return Response.json({
        ok: true,
        metrics: { meta: { count: 0, prevTS: 0, prevCount: 0 }, data: [], count: 0 },
      });
    }) as typeof fetch;
    const host = render('orders');
    await settle(5);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Agent target mismatch');
    expect(host.querySelector('[data-summary="failed"]')?.textContent).toContain(
      'Observed window total: Unavailable'
    );
    expect(host.querySelector('[data-summary="completed"]')?.textContent).toContain(
      'No terminal events'
    );
  });

  test('waits for an explicit valid queue and reports a missing paired agent', async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      return Response.json({});
    }) as typeof fetch;
    const host = render();
    expect(host.textContent).toContain('Choose a queue');
    expect(requests).toBe(0);
    act(() => useConnectionStore.setState({ agentBaseUrl: '' }));
    const input = host.querySelector('input[name="metric-history-queue"]') as HTMLInputElement;
    act(() => {
      const key = Object.keys(input).find((name) => name.startsWith('__reactProps$'))!;
      const props = (input as unknown as Record<string, { onChange: (event: unknown) => void }>)[
        key
      ];
      props.onChange({ target: { value: 'orders' } });
    });
    act(() =>
      host
        .querySelector('form')!
        .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
    );
    await settle(5);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('paired agent');
    expect(requests).toBe(0);
  });
});

function render(initialQueue = '') {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(createElement(MetricHistory, { initialQueue })));
  mounted.add(() => {
    act(() => root.unmount());
    host.remove();
  });
  return host;
}

function click(host: HTMLElement, text: string) {
  const button = [...host.querySelectorAll('button')].find((entry) => entry.textContent === text);
  if (!button) throw new Error(`Missing button ${text}`);
  act(() => button.click());
}
