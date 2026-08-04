import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { RuleForm } from '../src/pages/Alerts';
import { QueueDetail } from '../src/pages/QueueDetail';
import { QueueConfig } from '../src/pages/queue/QueueConfig';
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

function _deferred<T>() {
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

function _renderQueueDetail(name = 'orders') {
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

function clickTwice(element: Element): void {
  act(() => {
    element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
}

function setValue(element: HTMLInputElement | HTMLSelectElement, value: string): void {
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

function input(host: HTMLElement, name: string): HTMLInputElement {
  const element = host.querySelector<HTMLInputElement>(`[name="${name}"]`);
  if (!element) throw new Error(`No input named ${name}`);
  return element;
}

function _select(host: HTMLElement, name: string): HTMLSelectElement {
  const element = host.querySelector<HTMLSelectElement>(`[name="${name}"]`);
  if (!element) throw new Error(`No select named ${name}`);
  return element;
}

function _queueReadResponse(url: string): Response | null {
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

describe('classic QueueConfig desired-state writes', () => {
  test('Set and Clear in one tick acquire one queue-policy mutation lease', async () => {
    const mutations: string[] = [];
    globalThis.fetch = ((request: RequestInfo | URL, init?: RequestInit) => {
      const url = String(request);
      if (url.endsWith('/queues/summary')) return Promise.resolve(json(summary()));
      if (init?.method === 'PUT' || init?.method === 'DELETE') {
        mutations.push(init.method);
        return Promise.resolve(json({ ok: true }));
      }
      return Promise.resolve(json({ ok: false, error: 'unexpected request' }, 500));
    }) as typeof fetch;

    const { host } = render(createElement(QueueConfig, { queue: 'orders' }));
    setValue(input(host, 'classic-rate-limit'), '10');
    setValue(input(host, 'classic-rate-duration'), '60000');
    setValue(input(host, 'classic-rate-clear-queue'), 'orders');

    act(() => {
      findButton(host, 'Replace rate-limit policy').dispatchEvent(
        new window.MouseEvent('click', { bubbles: true })
      );
      findButton(host, 'Ensure no rate limit').dispatchEvent(
        new window.MouseEvent('click', { bubbles: true })
      );
    });
    await settle(12);

    expect(mutations).toEqual(['PUT']);
  });

  test('a malformed ACK shows an error and never creates a receipt', async () => {
    globalThis.fetch = ((request: RequestInfo | URL, init?: RequestInit) => {
      const url = String(request);
      if (url.endsWith('/queues/summary')) return Promise.resolve(json(summary()));
      if (init?.method === 'PUT') return Promise.resolve(json({}));
      return Promise.resolve(json({ ok: false, error: 'unexpected request' }, 500));
    }) as typeof fetch;

    const { host } = render(createElement(QueueConfig, { queue: 'orders' }));
    setValue(input(host, 'classic-concurrency'), '4');
    click(findButton(host, 'Replace concurrency policy'));
    await settle(12);

    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'Concurrency policy replaced returned a malformed success response'
    );
  });

  test('a valid ACK receipt says that current server state remains unreadable', async () => {
    globalThis.fetch = ((request: RequestInfo | URL, init?: RequestInit) => {
      const url = String(request);
      if (url.endsWith('/queues/summary')) return Promise.resolve(json(summary()));
      if (init?.method === 'PUT') return Promise.resolve(json({ ok: true }));
      return Promise.resolve(json({ ok: false, error: 'unexpected request' }, 500));
    }) as typeof fetch;

    const { host } = render(createElement(QueueConfig, { queue: 'orders' }));
    setValue(input(host, 'classic-concurrency'), '4');
    click(findButton(host, 'Replace concurrency policy'));
    await settle(12);

    const receipt = host.querySelector('[role="status"]')?.textContent ?? '';
    expect(receipt).toContain('Concurrency policy replaced applied at');
    expect(receipt).toContain('Current server state cannot be read.');
  });
});

describe('classic Alerts same-tick safety', () => {
  test('double Save rule in one tick invokes the add callback once', () => {
    const added: unknown[] = [];
    const { host } = render(
      createElement(RuleForm, {
        onAdd: (rule) => {
          added.push(rule);
          return { ok: true };
        },
      })
    );
    setValue(input(host, 'alert-rule-name'), 'High error rate');
    setValue(input(host, 'alert-rule-threshold'), '5');

    clickTwice(findButton(host, 'Save rule'));

    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      name: 'High error rate',
      metric: 'error_rate',
      operator: '>=',
      threshold: 5,
      queue: '',
      enabled: true,
    });
  });
});
