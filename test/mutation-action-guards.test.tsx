import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { AddJob } from '../src/pages/control/AddJob';
import { BulkAddJobs } from '../src/pages/control/BulkAddJobs';
import { CronManager } from '../src/pages/control/CronManager';
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

function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
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

const queuePage = {
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

describe('non-idempotent form mutexes', () => {
  test('AddJob submits once in the same tick and reports acceptance, not creation', async () => {
    const pending = deferred<Response>();
    let posts = 0;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/dashboard/queues')) return Promise.resolve(json(queuePage));
      if (init?.method === 'POST' && url.endsWith('/queues/orders/jobs')) {
        posts += 1;
        return pending.promise;
      }
      return Promise.resolve(json({ ok: false, error: 'unexpected request' }, 500));
    }) as typeof fetch;

    const { host } = render(createElement(MemoryRouter, null, createElement(AddJob)));
    await settle(3);
    const queueInput = host.querySelector<HTMLInputElement>('[name="target-queue"]')!;
    setValue(queueInput, 'orders');
    dispatchTwice(host.querySelector('form')!, 'submit');
    if (posts !== 1) throw new Error(`AddJob did not post: ${host.textContent}`);
    expect(posts).toBe(1);

    await act(async () => {
      pending.resolve(json({ ok: true, id: 'existing-id' }));
      await settle(5);
    });
    expect(host.textContent).toContain('Accepted job ID existing-id');
    expect(host.textContent).not.toContain('Created job');
  });

  test('BulkAddJobs submits once and treats repeated ids as deduplication ambiguity', async () => {
    const pending = deferred<Response>();
    let posts = 0;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/dashboard/queues')) return Promise.resolve(json(queuePage));
      if (init?.method === 'POST' && url.endsWith('/queues/orders/jobs/bulk')) {
        posts += 1;
        return pending.promise;
      }
      return Promise.resolve(json({ ok: false, error: 'unexpected request' }, 500));
    }) as typeof fetch;

    const { host } = render(createElement(BulkAddJobs));
    await settle(3);
    setValue(host.querySelector<HTMLInputElement>('[name="bulk-target-queue"]')!, 'orders');
    setValue(
      host.querySelector<HTMLTextAreaElement>('[name="jobs-json"]')!,
      '[{"data":{"n":1}},{"data":{"n":2}}]'
    );
    await settle(2);
    const button = [...host.querySelectorAll('button')].find((node) =>
      (node.textContent ?? '').includes('Import 2')
    );
    if (!button) throw new Error(`Bulk import button missing: ${host.textContent}`);
    dispatchTwice(button, 'click');
    expect(posts).toBe(1);

    await act(async () => {
      pending.resolve(json({ ok: true, ids: ['same-id', 'same-id'] }));
      await settle(5);
    });
    expect(host.textContent).toContain('Accepted 2 job submissions in orders');
    expect(host.textContent).toContain('1 distinct job ID');
    expect(host.textContent).not.toContain('Created 1');
  });

  test('Cron create and delete each acquire a synchronous mutex', async () => {
    const createPending = deferred<Response>();
    const deletePending = deferred<Response>();
    let creates = 0;
    let deletes = 0;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST' && url.endsWith('/crons')) {
        creates += 1;
        return createPending.promise;
      }
      if (init?.method === 'DELETE' && url.endsWith('/crons/existing')) {
        deletes += 1;
        return deletePending.promise;
      }
      if (url.endsWith('/crons')) {
        return Promise.resolve(
          json({
            ok: true,
            crons: [
              {
                name: 'existing',
                queue: 'orders',
                schedule: '0 8 * * *',
                nextRun: Date.now() + 60_000,
                executions: 0,
              },
            ],
          })
        );
      }
      return Promise.resolve(json({ ok: false, error: 'unexpected request' }, 500));
    }) as typeof fetch;

    const { host } = render(createElement(CronManager));
    await settle(5);
    setValue(host.querySelector<HTMLInputElement>('[name="cron-name"]')!, 'daily');
    setValue(host.querySelector<HTMLInputElement>('[name="cron-queue"]')!, 'orders');
    setValue(host.querySelector<HTMLInputElement>('[name="cron-expression"]')!, '0 9 * * *');
    dispatchTwice(host.querySelector('form')!, 'submit');
    // Creation first performs a fail-closed GET /crons preflight. The lease is
    // acquired before that await, so both same-tick submits still yield one POST.
    expect(creates).toBe(0);
    await settle(5);
    if (creates !== 1) throw new Error(`Cron did not post after preflight: ${host.textContent}`);
    expect(creates).toBe(1);

    await act(async () => {
      createPending.resolve(
        json({ ok: true, cron: { name: 'daily', queue: 'orders', schedule: '0 9 * * *' } })
      );
      await settle(5);
    });
    expect(host.textContent).toContain('Cron upsert acknowledged');

    const remove = host.querySelector<HTMLButtonElement>('[aria-label="Delete cron existing"]')!;
    dispatchTwice(remove, 'click');
    expect(deletes).toBe(1);
    await act(async () => {
      deletePending.resolve(json({ ok: true }));
      await settle(3);
    });
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
