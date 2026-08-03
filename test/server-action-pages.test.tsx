import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { useToastStore } from '../src/components/dashboard/stores/toastStore';
import { DlqControl } from '../src/pages/control/DlqControl';
import { DlqPro } from '../src/pages/control/DlqPro';
import { JobsPro } from '../src/pages/control/JobsPro';
import { QueuesOverview } from '../src/pages/control/QueuesOverview';
import { Webhooks } from '../src/pages/control/Webhooks';
import { WorkersPro } from '../src/pages/control/WorkersPro';
import { ensureDom, settle } from './domSetup';

const realFetch = globalThis.fetch;
const realConfirm = window.confirm;

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
  act(() => root.render(element));
  return {
    host,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

function buttonByText(host: HTMLElement, text: string): HTMLButtonElement {
  const button = [...host.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === text
  );
  if (!button) throw new Error(`No button with text "${text}"`);
  return button;
}

function clickSameTick(button: HTMLButtonElement, count = 2): void {
  act(() => {
    for (let index = 0; index < count; index++) {
      button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    }
  });
}

function setInput(input: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(
      input,
      value
    );
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}

const queueSummary = (name: string, paused = false) => ({
  name,
  paused,
  counts: { waiting: 1, prioritized: 0, active: 0, completed: 0, failed: 0, delayed: 0 },
});

const dashboardQueue = (name: string, dlq = 0) => ({
  name,
  waiting: 0,
  delayed: 0,
  active: 0,
  dlq,
  paused: false,
});

beforeEach(() => {
  ensureDom();
  useConnectionStore.setState({
    baseUrl: 'http://server-a.test',
    token: '',
    agentToken: '',
    refreshMs: 60_000,
  });
  useToastStore.setState({ toasts: [] });
  window.confirm = () => true;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  window.confirm = realConfirm;
  useConnectionStore.setState({
    baseUrl: '/api',
    token: '',
    agentToken: '',
    refreshMs: 3000,
  });
  useToastStore.setState({ toasts: [] });
});

describe('guarded job and entity actions', () => {
  test('JobsPro exposes no cancel, DLQ retry, or completed requeue mutation', async () => {
    let deleteCalls = 0;
    let retryCalls = 0;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/queues/summary')) {
        return Promise.resolve(json([queueSummary('orders')]));
      }
      if (url.endsWith('/stats')) {
        return Promise.resolve(
          json({
            ok: true,
            stats: {
              completed: 0,
              failed: 0,
              waiting: 1,
              prioritized: 0,
              active: 0,
              delayed: 0,
              'waiting-children': 0,
            },
          })
        );
      }
      if (url.includes('/queues/orders/jobs/list?')) {
        return Promise.resolve(
          json({
            ok: true,
            jobs: [
              { id: 'job-1', queue: 'orders', state: 'waiting' },
              { id: 'failed-1', queue: 'orders', state: 'failed' },
              { id: 'completed-1', queue: 'orders', state: 'completed' },
            ],
          })
        );
      }
      if (url.endsWith('/jobs/job-1') && method === 'DELETE') {
        deleteCalls += 1;
        return Promise.resolve(json({ ok: true }));
      }
      if (
        method === 'POST' &&
        (url.endsWith('/queues/orders/dlq/retry') || url.endsWith('/queues/orders/retry-completed'))
      ) {
        retryCalls += 1;
        return Promise.resolve(json({ ok: true, count: 1 }));
      }
      return Promise.resolve(json({ ok: false, error: `Unexpected ${method} ${url}` }, 500));
    }) as typeof fetch;

    const view = render(
      createElement(MemoryRouter, { initialEntries: ['/jobs'] }, createElement(JobsPro))
    );
    await settle(25);
    const cancel = view.host.querySelector<HTMLButtonElement>('button[aria-label="Cancel job"]');
    expect(cancel).toBeNull();
    expect(view.host.querySelector('button[aria-label="Retry job"]')).toBeNull();
    expect(view.host.querySelector('button[aria-label="Requeue job"]')).toBeNull();
    expect(view.host.textContent).not.toContain('Retry selected');
    expect(view.host.textContent).not.toContain('Requeue selected');
    expect(deleteCalls).toBe(0);
    expect(retryCalls).toBe(0);
    expect(view.host.textContent).toContain('job-1');
    expect(view.host.textContent).toContain('failed-1');
    expect(view.host.textContent).toContain('completed-1');
    view.unmount();
  });

  test('DlqControl exposes no row retry and cannot issue its POST', async () => {
    let retryCalls = 0;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('/dashboard/queues?')) {
        return Promise.resolve(
          json({
            ok: true,
            queues: [dashboardQueue('orders', 1)],
            total: 1,
            limit: 500,
            offset: 0,
            timestamp: Date.now(),
          })
        );
      }
      if (url.includes('/queues/orders/dlq/stats')) {
        return Promise.resolve(
          json({ ok: true, stats: { byReason: { failed: 1 }, pendingRetry: 0 } })
        );
      }
      if (url.includes('/queues/orders/dlq?')) {
        return Promise.resolve(
          json({
            ok: true,
            entries: [
              {
                job: { id: 'dead-1', queue: 'orders', attempts: 1 },
                enteredAt: 1000,
                reason: 'failed',
                error: 'boom',
              },
            ],
            total: 1,
          })
        );
      }
      if (url.endsWith('/queues/orders/dlq/retry') && method === 'POST') {
        retryCalls += 1;
        return Promise.resolve(json({ ok: true, count: 1 }));
      }
      return Promise.resolve(json({ ok: false, error: `Unexpected ${method} ${url}` }, 500));
    }) as typeof fetch;

    const view = render(createElement(MemoryRouter, {}, createElement(DlqControl)));
    await settle(35);
    const retry = view.host.querySelector<HTMLButtonElement>('button[aria-label="Retry job"]');
    expect(retry).toBeNull();
    const unavailable = view.host.querySelector<HTMLButtonElement>(
      'button[aria-label="Retry job unavailable"]'
    );
    expect(unavailable?.disabled).toBe(true);
    act(() => unavailable?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    expect(retryCalls).toBe(0);
    expect(useToastStore.getState().toasts).toEqual([]);
    view.unmount();
  });

  test('WorkersPro synchronously locks unregister by worker id', async () => {
    const mutation = deferred<Response>();
    let deletes = 0;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/workers') && method === 'GET') {
        return Promise.resolve(
          json({
            ok: true,
            data: {
              workers: [
                {
                  id: 'worker-1',
                  name: 'worker',
                  queues: ['orders'],
                  concurrency: 1,
                  hostname: 'worker.test',
                  pid: 42,
                  status: 'stale',
                  registeredAt: Date.now() - 1_000,
                  activeJobs: 0,
                  processedJobs: 1,
                  failedJobs: 0,
                  lastSeen: Date.now(),
                  currentJob: null,
                  uptime: 1_000,
                },
              ],
            },
          })
        );
      }
      if (url.endsWith('/workers/worker-1') && method === 'DELETE') {
        deletes += 1;
        return mutation.promise;
      }
      return Promise.resolve(json({ ok: false, error: `Unexpected ${method} ${url}` }, 500));
    }) as typeof fetch;

    const view = render(createElement(WorkersPro));
    await settle(20);
    const remove = view.host.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove stale registry record for worker worker-1"]'
    );
    expect(remove).not.toBeNull();
    clickSameTick(remove as HTMLButtonElement);
    expect(deletes).toBe(1);
    mutation.resolve(json({ ok: true }));
    await settle(20);
    expect(view.host.textContent).toContain('Removed stale registry record for worker-1');
    view.unmount();
  });
});

describe('retarget-safe bounded fan-outs', () => {
  test('QueuesOverview starts no new pool calls after a server retarget', async () => {
    const pending: Array<ReturnType<typeof deferred<Response>>> = [];
    const mutationUrls: string[] = [];
    const queues = Array.from({ length: 8 }, (_, index) => queueSummary(`q${index + 1}`));
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/queues/summary') && method === 'GET') {
        return Promise.resolve(json(queues));
      }
      if (url.includes('/queues/q') && url.endsWith('/pause') && method === 'POST') {
        mutationUrls.push(url);
        const request = deferred<Response>();
        pending.push(request);
        return request.promise;
      }
      return Promise.resolve(json({ ok: false, error: `Unexpected ${method} ${url}` }, 500));
    }) as typeof fetch;

    const view = render(createElement(MemoryRouter, {}, createElement(QueuesOverview)));
    await settle(20);
    clickSameTick(buttonByText(view.host, 'Pause all'), 1);
    await settle(10);
    expect(mutationUrls).toHaveLength(6);

    act(() => useConnectionStore.setState({ baseUrl: 'http://server-b.test' }));
    for (const request of pending) request.resolve(json({ ok: true }));
    await settle(25);
    expect(mutationUrls).toHaveLength(6);
    expect(view.host.textContent).not.toContain('Paused 8/8 queues');
    view.unmount();
  });

  test('DlqPro keeps global retry and purge disabled and sends no mutation', async () => {
    const mutationUrls: string[] = [];
    const queues = Array.from({ length: 8 }, (_, index) => dashboardQueue(`q${index + 1}`, 1));
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('/dashboard/queues?') && method === 'GET') {
        return Promise.resolve(
          json({
            ok: true,
            queues,
            total: queues.length,
            limit: 500,
            offset: 0,
            timestamp: Date.now(),
          })
        );
      }
      if (url.includes('/dlq/stats') && method === 'GET') {
        return Promise.resolve(json({ ok: true, stats: { byReason: {}, pendingRetry: 0 } }));
      }
      if (url.includes('/dlq?') && method === 'GET') {
        return Promise.resolve(json({ ok: true, entries: [], total: 0 }));
      }
      if (url.endsWith('/dlq/retry') && method === 'POST') {
        mutationUrls.push(url);
        return Promise.resolve(json({ ok: true, count: 1 }));
      }
      if (url.endsWith('/dlq/purge') && method === 'POST') {
        mutationUrls.push(url);
        return Promise.resolve(json({ ok: true, count: 1 }));
      }
      return Promise.resolve(json({ ok: false, error: `Unexpected ${method} ${url}` }, 500));
    }) as typeof fetch;

    const view = render(
      createElement(MemoryRouter, { initialEntries: ['/dlq'] }, createElement(DlqPro))
    );
    await settle(35);
    const retryAll = buttonByText(view.host, 'Retry all (8 queues)');
    const purgeAll = buttonByText(view.host, 'Purge all (8 queues)');
    expect(retryAll.disabled).toBeTrue();
    expect(purgeAll.disabled).toBeTrue();
    act(() => {
      retryAll.click();
      purgeAll.click();
    });
    await settle(10);
    expect(mutationUrls).toEqual([]);
    view.unmount();
  });
});

describe('webhook mutation intent', () => {
  const webhook = (enabled = false) => ({
    id: 'hook-1',
    url: 'https://example.test/hook',
    events: ['job.completed'],
    enabled,
    successCount: 0,
    failureCount: 0,
    lastTriggered: null,
    queue: null,
    createdAt: 1_000,
  });

  test('same-tick form submits and deletes each issue one mutation', async () => {
    const add = deferred<Response>();
    const remove = deferred<Response>();
    let addCalls = 0;
    let removeCalls = 0;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/webhooks') && method === 'GET') {
        return Promise.resolve(json({ ok: true, data: { webhooks: [webhook()] } }));
      }
      if (url.endsWith('/webhooks') && method === 'POST') {
        addCalls += 1;
        return add.promise;
      }
      if (url.endsWith('/webhooks/hook-1') && method === 'DELETE') {
        removeCalls += 1;
        return remove.promise;
      }
      return Promise.resolve(json({ ok: false, error: `Unexpected ${method} ${url}` }, 500));
    }) as typeof fetch;

    const view = render(createElement(Webhooks));
    await settle(20);
    const url = view.host.querySelector<HTMLInputElement>(
      'input[placeholder="https://example.com/hook"]'
    );
    expect(url).not.toBeNull();
    setInput(url as HTMLInputElement, 'https://receiver.test/hook');
    expect((url as HTMLInputElement).value).toBe('https://receiver.test/hook');
    const addButton = buttonByText(view.host, 'Add webhook');
    // HTMLElement.click() performs the submit button's default form action;
    // dispatchEvent(MouseEvent) alone only invokes explicit onClick handlers.
    act(() => {
      addButton.click();
      addButton.click();
    });
    expect(addCalls).toBe(1);
    add.resolve(json({ ok: true, id: 'new-hook' }));
    await settle(20);

    const deleteButton = view.host.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove webhook"]'
    );
    expect(deleteButton).not.toBeNull();
    clickSameTick(deleteButton as HTMLButtonElement);
    expect(removeCalls).toBe(1);
    remove.resolve(json({ ok: true }));
    await settle(20);
    view.unmount();
  });

  test('serializes and coalesces toggle writes so the latest intent wins on the server', async () => {
    const toggles: Array<{
      request: ReturnType<typeof deferred<Response>>;
      enabled: boolean;
    }> = [];
    let webhookGets = 0;
    let serverEnabled = false;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/webhooks') && method === 'GET') {
        webhookGets += 1;
        return Promise.resolve(json({ ok: true, data: { webhooks: [webhook(serverEnabled)] } }));
      }
      if (url.endsWith('/webhooks/hook-1/enabled') && method === 'PUT') {
        const request = deferred<Response>();
        const body = JSON.parse(String(init?.body)) as { enabled: boolean };
        toggles.push({ request, enabled: body.enabled });
        return request.promise;
      }
      return Promise.resolve(json({ ok: false, error: `Unexpected ${method} ${url}` }, 500));
    }) as typeof fetch;

    const view = render(createElement(Webhooks));
    await settle(20);
    const toggle = view.host.querySelector<HTMLButtonElement>('button[role="switch"]');
    expect(toggle?.getAttribute('aria-checked')).toBe('false');

    clickSameTick(toggle as HTMLButtonElement, 1); // intent 1: true
    await settle(5);
    clickSameTick(toggle as HTMLButtonElement, 1); // intent 2: false (latest)
    await settle(5);
    expect(toggles.map(({ enabled }) => enabled)).toEqual([true]);
    expect(toggle?.getAttribute('aria-checked')).toBe('false');

    serverEnabled = toggles[0]?.enabled ?? false;
    toggles[0]?.request.resolve(json({ ok: true }));
    await settle(10);
    expect(toggles.map(({ enabled }) => enabled)).toEqual([true, false]);
    expect(toggle?.getAttribute('aria-checked')).toBe('false');
    expect(webhookGets).toBe(1);

    serverEnabled = toggles[1]?.enabled ?? true;
    toggles[1]?.request.resolve(json({ ok: true }));
    await settle(20);
    expect(serverEnabled).toBe(false);
    expect(toggle?.getAttribute('aria-checked')).toBe('false');
    expect(webhookGets).toBe(2);
    view.unmount();
  });
});
