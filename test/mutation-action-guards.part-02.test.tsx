import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { QueueDetailPro } from '../src/pages/control/QueueDetailPro';
import { ensureDom, settle } from './domSetup';

const realFetch = globalThis.fetch;
const realConfirm = window.confirm;
const mounted = new Set<() => void>();

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'content-type': 'application/json' } });

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

function _setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  act(() => {
    const prototype =
      element.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
    // happy-dom does not currently drive React 19's change plugin for every
    // controlled input type. Invoke the exact onChange prop installed on this
    // DOM node after setting its native value; the browser event path itself is
    // covered in the broader form/a11y suites.
    const propsKey = Object.getOwnPropertyNames(element).find((key) =>
      key.startsWith('__reactProps$')
    );
    const props = propsKey
      ? ((element as unknown as Record<string, unknown>)[propsKey] as {
          onChange?: (event: { target: typeof element; currentTarget: typeof element }) => void;
        })
      : null;
    if (!props?.onChange) throw new Error('Controlled input has no React onChange handler');
    props.onChange({ target: element, currentTarget: element });
  });
}

function dispatchTwice(element: Element, event: 'click' | 'submit') {
  act(() => {
    element.dispatchEvent(
      event === 'click'
        ? new window.MouseEvent('click', { bubbles: true })
        : new window.Event('submit', { bubbles: true, cancelable: true })
    );
    element.dispatchEvent(
      event === 'click'
        ? new window.MouseEvent('click', { bubbles: true })
        : new window.Event('submit', { bubbles: true, cancelable: true })
    );
  });
}

const _queuePage = {
  ok: true,
  queues: [],
  total: 0,
  limit: 500,
  offset: 0,
  timestamp: 1,
};

beforeEach(() => {
  ensureDom();
  window.confirm = () => true;
  useConnectionStore.setState({
    baseUrl: 'http://server-a.test',
    token: 'token-a',
    agentToken: '',
    refreshMs: 3_000,
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

describe('route and connection ownership', () => {
  test('QueueDetailPro suppresses stale success after a server retarget', async () => {
    const pausePending = deferred<Response>();
    let pausePosts = 0;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST' && url.endsWith('/queues/orders/pause')) {
        pausePosts += 1;
        return pausePending.promise;
      }
      if (url.endsWith('/queues/summary')) {
        return Promise.resolve(
          json([
            {
              name: 'orders',
              paused: false,
              counts: {
                waiting: 1,
                prioritized: 0,
                active: 0,
                completed: 0,
                failed: 0,
                delayed: 0,
              },
            },
          ])
        );
      }
      if (url.includes('/dashboard/queues/orders')) {
        return Promise.resolve(
          json({
            ok: true,
            name: 'orders',
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
            paused: false,
            priorityCounts: {},
            dlqPreview: [],
            timestamp: 1,
          })
        );
      }
      if (url.endsWith('/queues/orders/stall-config')) {
        return Promise.resolve(
          json({
            ok: true,
            config: { enabled: true, stallInterval: 30_000, maxStalls: 3, gracePeriod: 5_000 },
          })
        );
      }
      if (url.endsWith('/queues/orders/dlq-config')) {
        return Promise.resolve(
          json({
            ok: true,
            config: {
              autoRetry: false,
              autoRetryInterval: 3_600_000,
              maxAutoRetries: 3,
              maxAge: 604_800_000,
              maxEntries: 10_000,
            },
          })
        );
      }
      if (url.includes('/queues/orders/jobs/list')) {
        return Promise.resolve(json({ ok: true, jobs: [] }));
      }
      return Promise.resolve(json({ ok: false, error: 'unexpected request' }, 500));
    }) as typeof fetch;

    const { host } = render(
      createElement(
        MemoryRouter,
        { initialEntries: ['/queues/orders'] },
        createElement(
          Routes,
          null,
          createElement(Route, {
            path: '/queues/:name',
            element: createElement(QueueDetailPro),
          })
        )
      )
    );
    await settle(12);
    const pause = [...host.querySelectorAll('button')].find((button) =>
      (button.textContent ?? '').includes('Pause')
    )!;
    dispatchTwice(pause, 'click');
    await settle(3);
    expect(pausePosts).toBe(1);

    act(() => useConnectionStore.setState({ baseUrl: 'http://server-b.test', token: 'token-b' }));
    await act(async () => {
      pausePending.resolve(json({ ok: true }));
      await settle(8);
    });
    expect(host.textContent).not.toContain('Paused ✓');
  });
});
