import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { formatBytes, formatNumber } from '../src/lib/format';
import { McpServer } from '../src/pages/control/McpServer';
import { Metrics } from '../src/pages/Metrics';
import { Queues } from '../src/pages/Queues';
import { Usage } from '../src/pages/Usage';
import { Workers } from '../src/pages/Workers';
import { ensureDom, settle } from './domSetup';
import { classicOverview, classicQueues } from './fixtures/classic-dashboard';

const originalFetch = globalThis.fetch;
const mounted = new Set<() => void>();

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function render(element: ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const unmount = () => {
    act(() => root.unmount());
    host.remove();
    mounted.delete(unmount);
  };
  mounted.add(unmount);
  act(() => root.render(element));
  return { host, unmount };
}

function setInput(input: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(
      input,
      value
    );
    const propsKey = Object.getOwnPropertyNames(input).find((key) =>
      key.startsWith('__reactProps$')
    );
    const props = propsKey
      ? ((input as unknown as Record<string, unknown>)[propsKey] as {
          onChange?: (event: { target: HTMLInputElement; currentTarget: HTMLInputElement }) => void;
        })
      : null;
    if (!props?.onChange) throw new Error('Controlled input has no React onChange handler');
    props.onChange({ target: input, currentTarget: input });
  });
}

function click(button: HTMLButtonElement): void {
  act(() => button.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
}

beforeEach(() => {
  ensureDom();
  useConnectionStore.setState({ baseUrl: 'http://classic.test', token: '', agentToken: '' });
});

afterEach(() => {
  for (const unmount of [...mounted]) unmount();
  globalThis.fetch = originalFetch;
  useConnectionStore.setState({ baseUrl: '/api', token: '', agentToken: '' });
});

describe('classic dashboard pages', () => {
  test('Metrics renders real nested percentiles, totals, memory and collection values', async () => {
    globalThis.fetch = async () => json(classicOverview());
    const view = render(createElement(Metrics));
    expect(view.host.textContent).toContain('Loading metrics…');
    await settle(10);

    expect(view.host.textContent).toContain('push p95');
    expect(view.host.textContent).toContain(`${formatNumber(9.5)}ms`);
    expect(view.host.textContent).toContain(formatNumber(1_850));
    expect(view.host.textContent).toContain(formatBytes(64 * 1024 * 1024));
    expect(view.host.textContent).toContain('jobs');
    expect(view.host.textContent).not.toContain('[object Object]');
  });

  test('Metrics reports an initial transport failure and exposes retry', async () => {
    globalThis.fetch = async () => json({ error: 'metrics unavailable' }, 503);
    const view = render(createElement(Metrics));
    await settle(10);
    expect(view.host.textContent).toContain('metrics unavailable');
    expect(
      [...view.host.querySelectorAll('button')].some((button) => button.textContent === 'Retry')
    ).toBe(true);
  });

  test('Queues filters its current server page and requests the next exact offset', async () => {
    const offsets: number[] = [];
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/dashboard') return json(classicOverview());
      const offset = Number(url.searchParams.get('offset'));
      offsets.push(offset);
      return json(classicQueues(offset));
    };
    const view = render(createElement(MemoryRouter, {}, createElement(Queues)));
    await settle(10);

    const links = () => [...view.host.querySelectorAll<HTMLAnchorElement>('tbody a')];
    expect(links()).toHaveLength(20);
    expect(links()[1]?.getAttribute('href')).toBe('/queues-classic/queue-01');
    expect(view.host.textContent).toContain('Paused');

    const filter = view.host.querySelector<HTMLInputElement>('input[aria-label="Filter queues"]');
    if (!filter) throw new Error('Queue filter missing');
    setInput(filter, 'queue-01');
    await settle(0);
    expect(links().map((link) => link.textContent?.trim())).toEqual(['queue-01']);

    setInput(filter, '');
    await settle(0);
    const next = [...view.host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Next'
    );
    if (!next) throw new Error('Next page button missing');
    click(next);
    await settle(10);
    expect(offsets).toContain(20);
    expect(links().map((link) => link.textContent?.trim())).toEqual(['omega-final']);
    expect(view.host.textContent).toContain('21–21 of 21 queues');
  });

  test('Queues keeps an honest empty row when both inventory requests fail', async () => {
    globalThis.fetch = async () => json({ error: 'broker offline' }, 503);
    const view = render(createElement(MemoryRouter, {}, createElement(Queues)));
    await settle(10);
    expect(view.host.textContent).toContain('Could not load queues — broker offline');
    expect(view.host.textContent).toContain('Queue inventory unavailable');
  });

  test('Usage renders runtime and an explicit disk-full diagnostic', async () => {
    globalThis.fetch = async () =>
      json(
        classicOverview({
          storage: { diskFull: true, error: 'ENOSPC', since: Date.now() - 60_000 },
        })
      );
    const view = render(createElement(Usage));
    await settle(10);
    expect(view.host.textContent).toContain(formatNumber(2_000));
    expect(view.host.textContent).toContain('1h 2m');
    expect(view.host.textContent).toContain('Disk full');
    expect(view.host.textContent).toContain('ENOSPC');
  });

  test('Workers renders registry details, fallback labels and truncation honestly', async () => {
    const fixture = classicOverview();
    fixture.workers = { ...fixture.workers, total: 120, truncated: true };
    globalThis.fetch = async () => json(fixture);
    const view = render(createElement(Workers));
    await settle(10);
    expect(view.host.textContent).toContain('mailer');
    expect(view.host.textContent).toContain('worker-b');
    expect(view.host.textContent).toContain('Showing first 2 of 120 workers');
    expect(view.host.textContent).toContain('emails');
  });

  test('Workers and Usage fail closed when no first snapshot is available', async () => {
    globalThis.fetch = async () => json({ error: 'unreachable' }, 500);
    const workers = render(createElement(Workers));
    const usage = render(createElement(Usage));
    await settle(10);
    expect(workers.host.textContent).toContain('Worker inventory is unavailable');
    expect(usage.host.textContent).toContain('Cumulative resource usage is unavailable');
    expect(workers.host.textContent).toContain('unreachable');
    expect(usage.host.textContent).toContain('unreachable');
  });
});

describe('MCP reference page', () => {
  test('renders the complete static contract and safe external documentation link', () => {
    const view = render(createElement(McpServer));
    expect(view.host.textContent).toContain('73 total');
    expect(view.host.textContent).toContain('12');
    expect(view.host.textContent).toContain('bunqueue://queues');
    expect(view.host.textContent).toContain('bunqueue_incident_response');
    expect(view.host.textContent).toContain('bunqueue-mcp');
    expect(view.host.textContent).toContain('BUNQUEUE_TOKEN');
    expect(view.host.querySelectorAll('button[aria-label="Copy to clipboard"]')).toHaveLength(3);
    const docs = view.host.querySelector<HTMLAnchorElement>('a[target="_blank"]');
    expect(docs?.rel).toContain('noopener');
    expect(docs?.rel).toContain('noreferrer');
  });
});
