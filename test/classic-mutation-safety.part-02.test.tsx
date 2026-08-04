import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { QueueDetail } from '../src/pages/QueueDetail';
import { ensureDom, settle } from './domSetup';

const realFetch = globalThis.fetch;
const realConfirm = window.confirm;
const mounted = new Set<() => void>();

const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'content-type': 'application/json' } });

const summary = (name = 'orders', paused = false) => [
  {
    name,
    paused,
    counts: {
      waiting: 1,
      prioritized: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
    },
  },
];

const detail = (name = 'orders', paused = false) => ({
  ok: true,
  name,
  counts: {
    waiting: 1,
    active: 0,
    completed: 0,
    failed: 0,
    delayed: 0,
    prioritized: 0,
    'waiting-children': 0,
    paused: 0,
  },
  paused,
  priorityCounts: {},
  dlqPreview: [],
  timestamp: 1,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function render(element: ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  let active = true;
  const unmount = () => {
    if (!active) return;
    active = false;
    act(() => root.unmount());
    host.remove();
    mounted.delete(unmount);
  };
  mounted.add(unmount);
  act(() => root.render(element));
  return { host, unmount };
}

function renderQueueDetail(name = 'orders') {
  return render(
    createElement(
      MemoryRouter,
      { initialEntries: [`/queues-classic/${name}`] },
      createElement(
        Routes,
        null,
        createElement(Route, {
          path: '/queues-classic/:name',
          element: createElement(QueueDetail),
        })
      )
    )
  );
}

function findButton(host: HTMLElement, label: string): HTMLButtonElement {
  const button = [...host.querySelectorAll('button')].find((candidate) =>
    (candidate.textContent ?? '').includes(label)
  );
  if (!button) throw new Error(`No button matching "${label}"`);
  return button;
}

function click(element: Element): void {
  act(() => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
}

function _clickTwice(element: Element): void {
  act(() => {
    element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
}

function _setValue(element: HTMLInputElement | HTMLSelectElement, value: string): void {
  act(() => {
    const prototype =
      element.tagName === 'SELECT'
        ? window.HTMLSelectElement.prototype
        : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
    if (element.tagName === 'SELECT') {
      element.dispatchEvent(new window.Event('input', { bubbles: true }));
      element.dispatchEvent(new window.Event('change', { bubbles: true }));
      return;
    }
    const propsKey = Object.getOwnPropertyNames(element).find((key) =>
      key.startsWith('__reactProps$')
    );
    const props = propsKey
      ? ((element as unknown as Record<string, unknown>)[propsKey] as {
          onChange?: (event: { target: typeof element; currentTarget: typeof element }) => void;
        })
      : null;
    if (!props?.onChange)
      throw new Error(`Control ${element.getAttribute('name')} has no onChange`);
    props.onChange({ target: element, currentTarget: element });
  });
}

function _input(host: HTMLElement, name: string): HTMLInputElement {
  const element = host.querySelector<HTMLInputElement>(`[name="${name}"]`);
  if (!element) throw new Error(`No input named ${name}`);
  return element;
}

function _select(host: HTMLElement, name: string): HTMLSelectElement {
  const element = host.querySelector<HTMLSelectElement>(`[name="${name}"]`);
  if (!element) throw new Error(`No select named ${name}`);
  return element;
}

function queueReadResponse(url: string): Response | null {
  if (url.endsWith('/queues/summary')) return json(summary());
  if (url.includes('/dashboard/queues/orders?includeJobs=false')) return json(detail());
  if (url.includes('/queues/orders/jobs/list?')) return json({ ok: true, jobs: [] });
  return null;
}

beforeEach(() => {
  ensureDom();
  window.confirm = () => true;
  useConnectionStore.setState({
    baseUrl: 'http://server-a.test',
    token: 'token-a',
    agentToken: '',
    refreshMs: 60_000,
  });
});

afterEach(() => {
  for (const unmount of [...mounted]) unmount();
  globalThis.fetch = realFetch;
  window.confirm = realConfirm;
  useConnectionStore.setState({
    baseUrl: '/api',
    token: '',
    agentToken: '',
    refreshMs: 3_000,
  });
});

describe('classic QueueDetail mutation safety', () => {
  test('does not publish an old mutation result after a server retarget', async () => {
    const pending = deferred<Response>();
    let serverBSummaries = 0;
    globalThis.fetch = ((request: RequestInfo | URL, init?: RequestInit) => {
      const url = String(request);
      if (
        url.startsWith('http://server-a.test') &&
        init?.method === 'POST' &&
        url.endsWith('/queues/orders/pause')
      ) {
        return pending.promise;
      }
      if (url.startsWith('http://server-b.test') && url.endsWith('/queues/summary')) {
        serverBSummaries += 1;
      }
      const response = queueReadResponse(url);
      return Promise.resolve(response ?? json({ ok: false, error: 'unexpected request' }, 500));
    }) as typeof fetch;

    const { host } = renderQueueDetail();
    await settle(12);
    click(findButton(host, 'Pause'));
    await settle(6);

    act(() => {
      useConnectionStore.setState({ baseUrl: 'http://server-b.test', token: 'token-b' });
    });
    await settle(12);
    expect(serverBSummaries).toBe(1);

    await act(async () => {
      // This response would display an ACK error if the old lease were still
      // allowed to publish into the retargeted page.
      pending.resolve(json({}));
      await settle(12);
    });

    expect(serverBSummaries).toBe(1);
    expect(host.textContent).not.toContain('malformed success response');
    expect(host.textContent).toContain('orders');
  });
});
