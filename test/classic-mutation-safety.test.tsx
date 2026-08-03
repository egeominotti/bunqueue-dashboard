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

function select(host: HTMLElement, name: string): HTMLSelectElement {
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
  test('a failed refresh keeps the snapshot but replaces the contradictory Live badge', async () => {
    useConnectionStore.setState({ refreshMs: 20 });
    let summaries = 0;
    globalThis.fetch = ((request: RequestInfo | URL) => {
      const url = String(request);
      if (url.endsWith('/queues/summary')) {
        summaries += 1;
        return Promise.resolve(
          summaries === 1 ? json(summary()) : json({ error: 'refresh unavailable' }, 502)
        );
      }
      const response = queueReadResponse(url);
      return Promise.resolve(response ?? json({ ok: false, error: 'unexpected request' }, 500));
    }) as typeof fetch;

    const { host, unmount } = renderQueueDetail();
    await settle(12);
    expect(
      Array.from(host.querySelectorAll('span')).some((node) => node.textContent === 'Live')
    ).toBe(true);
    expect(host.textContent).toContain('orders');

    await settle(45);
    expect(host.textContent).toContain('Could not refresh bunqueue data');
    expect(host.textContent).toContain('Stale');
    expect(
      Array.from(host.querySelectorAll('span')).some((node) => node.textContent === 'Live')
    ).toBe(false);
    // The last good data remains visible while its freshness is honest.
    expect(host.textContent).toContain('Waiting1');
    unmount();
  });

  test('checks the exact v2.8.55 /queues/summary registry and hides controls for an absent queue', async () => {
    const calls: string[] = [];
    globalThis.fetch = ((request: RequestInfo | URL) => {
      const url = String(request);
      calls.push(new URL(url).pathname);
      if (url.endsWith('/queues/summary')) return Promise.resolve(json([]));
      return Promise.resolve(json({ ok: false, error: 'unexpected request' }, 500));
    }) as typeof fetch;

    const { host } = renderQueueDetail('missing');
    await settle(12);

    expect(calls).toEqual(['/queues/summary']);
    expect(host.textContent).toContain('Queue not found');
    expect(host.textContent).not.toContain('Pause');
    expect(host.textContent).not.toContain('Resume');
    expect(host.textContent).not.toContain('Configuration');
  });

  test('double Pause in one tick sends one POST', async () => {
    const pending = deferred<Response>();
    let posts = 0;
    globalThis.fetch = ((request: RequestInfo | URL, init?: RequestInit) => {
      const url = String(request);
      if (init?.method === 'POST' && url.endsWith('/queues/orders/pause')) {
        posts += 1;
        return pending.promise;
      }
      const response = queueReadResponse(url);
      return Promise.resolve(response ?? json({ ok: false, error: 'unexpected request' }, 500));
    }) as typeof fetch;

    const { host } = renderQueueDetail();
    await settle(12);
    clickTwice(findButton(host, 'Pause'));
    await settle(4);
    expect(posts).toBe(1);

    await act(async () => {
      pending.resolve(json({ ok: true }));
      await settle(12);
    });
  });

  test('rejects a malformed mutation ACK instead of reporting success', async () => {
    globalThis.fetch = ((request: RequestInfo | URL, init?: RequestInit) => {
      const url = String(request);
      if (init?.method === 'POST' && url.endsWith('/queues/orders/pause')) {
        return Promise.resolve(json({}));
      }
      const response = queueReadResponse(url);
      return Promise.resolve(response ?? json({ ok: false, error: 'unexpected request' }, 500));
    }) as typeof fetch;

    const { host } = renderQueueDetail();
    await settle(12);
    click(findButton(host, 'Pause'));
    await settle(12);

    expect(host.textContent).toContain('pause returned a malformed success response');
  });

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

describe('classic QueueConfig desired-state writes', () => {
  test('rejects zero, negative, fractional, and unsafe integers without a PUT', () => {
    let puts = 0;
    globalThis.fetch = ((_request: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') puts += 1;
      return Promise.resolve(json({ ok: true }));
    }) as typeof fetch;

    const { host } = render(createElement(QueueConfig, { queue: 'orders' }));
    const rateButton = findButton(host, 'Replace rate-limit policy');
    const concurrencyButton = findButton(host, 'Replace concurrency policy');
    const invalidValues = ['0', '-1', '0.5', String(Number.MAX_SAFE_INTEGER + 1)];

    setValue(input(host, 'classic-rate-duration'), '60000');
    for (const value of invalidValues) {
      setValue(input(host, 'classic-rate-limit'), value);
      expect(rateButton.disabled).toBe(true);
      click(rateButton);
    }

    setValue(input(host, 'classic-rate-limit'), '10');
    for (const value of invalidValues) {
      setValue(input(host, 'classic-rate-duration'), value);
      expect(rateButton.disabled).toBe(true);
      click(rateButton);
    }

    setValue(input(host, 'classic-rate-duration'), '60000');
    setValue(select(host, 'classic-rate-ttl-mode'), 'expires');
    for (const value of invalidValues) {
      setValue(input(host, 'classic-rate-ttl'), value);
      expect(rateButton.disabled).toBe(true);
      click(rateButton);
    }

    for (const value of invalidValues) {
      setValue(input(host, 'classic-concurrency'), value);
      expect(concurrencyButton.disabled).toBe(true);
      click(concurrencyButton);
    }

    expect(puts).toBe(0);
  });

  test('valid values send the exact v2.8.55 duration, TTL, and concurrency bodies', async () => {
    const mutations: Array<{ path: string; method: string; body: unknown }> = [];
    globalThis.fetch = ((request: RequestInfo | URL, init?: RequestInit) => {
      const url = String(request);
      if (url.endsWith('/queues/summary')) return Promise.resolve(json(summary()));
      if (init?.method === 'PUT') {
        mutations.push({
          path: new URL(url).pathname,
          method: init.method,
          body: JSON.parse(String(init.body)),
        });
        return Promise.resolve(json({ ok: true }));
      }
      return Promise.resolve(json({ ok: false, error: 'unexpected request' }, 500));
    }) as typeof fetch;

    const { host } = render(createElement(QueueConfig, { queue: 'orders' }));
    setValue(input(host, 'classic-rate-limit'), '10');
    setValue(input(host, 'classic-rate-duration'), '60000');
    setValue(select(host, 'classic-rate-ttl-mode'), 'expires');
    setValue(input(host, 'classic-rate-ttl'), '3600000');
    click(findButton(host, 'Replace rate-limit policy'));
    await settle(12);

    setValue(input(host, 'classic-concurrency'), '4');
    click(findButton(host, 'Replace concurrency policy'));
    await settle(12);

    expect(mutations).toEqual([
      {
        path: '/queues/orders/rate-limit',
        method: 'PUT',
        body: { limit: 10, duration: 60_000, ttl: 3_600_000 },
      },
      {
        path: '/queues/orders/concurrency',
        method: 'PUT',
        body: { concurrency: 4 },
      },
    ]);
  });

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
