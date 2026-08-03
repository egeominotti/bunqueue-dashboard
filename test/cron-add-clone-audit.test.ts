import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import {
  AddJob,
  addJobCloneDefaults,
  MAX_JOB_DATA_CHARS,
  parseAddJobNumbers,
} from '../src/pages/control/AddJob';
import {
  assertCronNameAvailable,
  buildCronBody,
  type CronFormValues,
  CronManager,
  existingCronNameError,
} from '../src/pages/control/CronManager';
import { ensureDom, settle } from './domSetup';

const realFetch = globalThis.fetch;
const realConfirm = window.confirm;
const mountedViews = new Set<() => void>();

const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'content-type': 'application/json' } });

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
  let mounted = true;
  const unmount = () => {
    if (!mounted) return;
    mounted = false;
    mountedViews.delete(unmount);
    act(() => root.unmount());
    host.remove();
  };
  mountedViews.add(unmount);
  return {
    host,
    unmount,
  };
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

const cronValues = (schedule: string): CronFormValues => ({
  name: 'hourly-report',
  queue: 'reports',
  mode: 'cron',
  schedule,
  every: '',
  dataText: '{}',
  timezone: '',
  priority: '',
  preventOverlap: true,
  skipIfNoWorker: false,
  maxLimit: '',
  immediately: false,
  skipMissedOnRestart: true,
  uniqueKey: '',
  dedupTtl: '',
  dedupExtend: false,
  dedupReplace: false,
  jobMaxAttempts: '',
  jobBackoff: '',
  jobTimeout: '',
  jobDelay: '',
  jobStallTimeout: '',
  jobRemoveOnComplete: false,
  jobRemoveOnFail: false,
});

beforeEach(() => {
  ensureDom();
  useConnectionStore.setState({
    baseUrl: 'http://cron-clone.test',
    token: '',
    agentToken: '',
    refreshMs: 60_000,
  });
  window.confirm = () => true;
});

afterEach(() => {
  for (const unmount of [...mountedViews]) unmount();
  globalThis.fetch = realFetch;
  window.confirm = realConfirm;
  useConnectionStore.setState({
    baseUrl: '/api',
    token: '',
    agentToken: '',
    refreshMs: 3000,
  });
  document.body.replaceChildren();
});

describe('CronManager v2.8.55 contract', () => {
  test('transports shortcuts and six-field expressions even when local preview cannot parse them', () => {
    const shortcut = buildCronBody(cronValues('  @hourly  '));
    expect(shortcut.ok).toBe(true);
    if (shortcut.ok) expect(shortcut.body.schedule).toBe('@hourly');

    const sixFields = buildCronBody(cronValues('*/10 * * * * *'));
    expect(sixFields.ok).toBe(true);
    if (sixFields.ok) expect(sixFields.body.schedule).toBe('*/10 * * * * *');

    // The local helper is a preview only; the server's Croner parser is the
    // authoritative validator for every non-empty expression.
    expect(buildCronBody(cronValues('')).ok).toBe(false);
  });

  test('refuses cron names that URL parsing would retarget or cannot encode', () => {
    const dot = buildCronBody({ ...cronValues('@hourly'), name: '.' });
    expect(dot.ok).toBe(false);
    if (!dot.ok) expect(dot.msg).toContain('path traversal segment');
    expect(buildCronBody({ ...cronValues('@hourly'), name: '..' }).ok).toBe(false);
    expect(buildCronBody({ ...cronValues('@hourly'), name: '\ud800' }).ok).toBe(false);
  });

  test('rejects oversized UTF-8 cron data before JSON.parse', () => {
    const originalParse = JSON.parse;
    let parseCalls = 0;
    Object.defineProperty(JSON, 'parse', {
      configurable: true,
      writable: true,
      value: ((...args: Parameters<typeof JSON.parse>) => {
        parseCalls += 1;
        return originalParse(...args);
      }) as typeof JSON.parse,
    });

    try {
      const utf8Oversize = `"${'💥'.repeat(MAX_JOB_DATA_CHARS / 4 + 1)}"`;
      expect(utf8Oversize.length).toBeLessThan(MAX_JOB_DATA_CHARS);
      const result = buildCronBody({
        ...cronValues('@hourly'),
        dataText: utf8Oversize,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.msg).toContain('too large');
      expect(parseCalls).toBe(0);
    } finally {
      Object.defineProperty(JSON, 'parse', {
        configurable: true,
        writable: true,
        value: originalParse,
      });
    }
  });

  test('fails closed when an upsert name is known or cannot be checked', () => {
    const names = new Set(['hourly-report']);
    expect(existingCronNameError(' hourly-report ', names)).toContain('does not return complete');
    expect(existingCronNameError('new-report', names)).toBeNull();

    expect(() =>
      assertCronNameAvailable({ ok: true, crons: [{ name: 'hourly-report' }] }, 'hourly-report')
    ).toThrow('already exists');
    expect(() => assertCronNameAvailable({ ok: true, crons: [] }, 'hourly-report')).not.toThrow();
    expect(() => assertCronNameAvailable({ ok: true }, 'hourly-report')).toThrow(
      'creation was not attempted'
    );
  });

  test('an existing name disables create and cannot submit an update', async () => {
    let posts = 0;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/crons') && (init?.method ?? 'GET') === 'GET') {
        return Promise.resolve(
          json({
            ok: true,
            crons: [
              {
                name: 'hourly-report',
                queue: 'reports',
                schedule: '@hourly',
                nextRun: Date.now() + 60_000,
                executions: 0,
              },
            ],
          })
        );
      }
      if (url.endsWith('/crons') && init?.method === 'POST') {
        posts += 1;
        return Promise.resolve(json({ ok: true }));
      }
      return Promise.resolve(json({ ok: false, error: 'unexpected request' }, 500));
    }) as typeof fetch;

    const view = render(createElement(CronManager));
    await settle(10);
    setInput(view.host.querySelector<HTMLInputElement>('[name="cron-name"]')!, 'hourly-report');
    setInput(view.host.querySelector<HTMLInputElement>('[name="cron-queue"]')!, 'reports');
    setInput(view.host.querySelector<HTMLInputElement>('[name="cron-expression"]')!, '@hourly');
    await settle(1);

    const create = [...view.host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Name already exists')
    );
    if (!create) throw new Error(`Create conflict state missing: ${view.host.textContent}`);
    expect(create?.disabled).toBe(true);
    expect(view.host.textContent).toContain('Delete it explicitly');
    act(() =>
      view.host
        .querySelector('form')!
        .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
    );
    await settle(2);
    expect(posts).toBe(0);
    view.unmount();
  });

  test('a server retarget during the name preflight never redirects the upsert', async () => {
    const preflight = deferred<Response>();
    let gets = 0;
    let posts = 0;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/crons') && (init?.method ?? 'GET') === 'GET') {
        gets += 1;
        if (gets === 2) return preflight.promise;
        return Promise.resolve(json({ ok: true, crons: [] }));
      }
      if (url.endsWith('/crons') && init?.method === 'POST') {
        posts += 1;
        return Promise.resolve(json({ ok: true, cron: { name: 'new-report', queue: 'reports' } }));
      }
      return Promise.resolve(json({ ok: false, error: 'unexpected request' }, 500));
    }) as typeof fetch;

    const view = render(createElement(CronManager));
    await settle(10);
    setInput(view.host.querySelector<HTMLInputElement>('[name="cron-name"]')!, 'new-report');
    setInput(view.host.querySelector<HTMLInputElement>('[name="cron-queue"]')!, 'reports');
    setInput(view.host.querySelector<HTMLInputElement>('[name="cron-expression"]')!, '@hourly');
    act(() =>
      view.host
        .querySelector('form')!
        .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
    );
    await settle(1);
    expect(gets).toBe(2);

    act(() => useConnectionStore.setState({ baseUrl: 'http://other-server.test' }));
    preflight.resolve(json({ ok: true, crons: [] }));
    await settle(10);
    expect(posts).toBe(0);
    view.unmount();
  });
});

describe('AddJob clone fidelity', () => {
  test('structured backoff, tags, group and ttl seed the exact controlled fields', () => {
    expect(
      addJobCloneDefaults({
        backoff: 999,
        backoffConfig: { type: 'exponential', delay: 250 },
        tags: ['billing', 'urgent'],
        groupId: 'tenant-42',
        ttl: 3_600_000,
      })
    ).toEqual({
      backoff: '250',
      backoffType: 'exponential',
      tags: 'billing, urgent',
      groupId: 'tenant-42',
      ttl: '3600000',
    });
    expect(addJobCloneDefaults({})).toEqual({
      backoff: '',
      backoffType: '',
      tags: '',
      groupId: '',
      ttl: '',
    });
  });

  test('ttl follows the exact PUSH bounds without breaking older callers', () => {
    expect(
      parseAddJobNumbers({
        priority: '',
        delay: '',
        maxAttempts: '',
        backoff: '',
        timeout: '',
        ttl: '31536000000',
      })
    ).toEqual({ ok: true, options: { ttl: 31_536_000_000 } });
    expect(
      parseAddJobNumbers({
        priority: '',
        delay: '',
        maxAttempts: '',
        backoff: '',
        timeout: '',
        ttl: '-1',
      }).ok
    ).toBe(false);
    expect(
      parseAddJobNumbers({
        priority: '',
        delay: '',
        maxAttempts: '',
        backoff: '',
        timeout: '',
        ttl: '31536000001',
      }).ok
    ).toBe(false);
    expect(
      parseAddJobNumbers({
        priority: '',
        delay: '',
        maxAttempts: '',
        backoff: '',
        timeout: '',
      })
    ).toEqual({ ok: true, options: {} });
  });

  test('submitting a clone preserves every newly supported option in the POST body', async () => {
    let posted: Record<string, unknown> | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('/dashboard/queues?') && method === 'GET') {
        return json({ ok: true, queues: [], total: 0, limit: 500, offset: 0 });
      }
      if (url.endsWith('/queues/emails/jobs') && method === 'POST') {
        posted = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return json({ ok: true, id: 'fresh-clone' });
      }
      return json({ ok: false, error: `Unexpected ${method} ${url}` }, 500);
    }) as typeof fetch;

    const view = render(
      createElement(
        MemoryRouter,
        {
          initialEntries: [
            {
              pathname: '/jobs/add',
              state: {
                clone: {
                  queue: 'emails',
                  dataText: '{"message":"hello"}',
                  options: {
                    backoff: 999,
                    backoffConfig: { type: 'fixed', delay: 1250 },
                    tags: ['mail', 'priority'],
                    groupId: 'tenant-a',
                    ttl: 60_000,
                  },
                },
              },
            },
          ],
        },
        createElement(AddJob)
      )
    );
    await settle(10);

    expect(view.host.querySelector<HTMLInputElement>('[name="backoff"]')?.value).toBe('1250');
    expect(view.host.querySelector<HTMLSelectElement>('[name="backoff-strategy"]')?.value).toBe(
      'fixed'
    );
    expect(view.host.querySelector<HTMLInputElement>('[name="tags"]')?.value).toBe(
      'mail, priority'
    );
    expect(view.host.querySelector<HTMLInputElement>('[name="group-id"]')?.value).toBe('tenant-a');
    expect(view.host.querySelector<HTMLInputElement>('[name="ttl"]')?.value).toBe('60000');

    act(() =>
      view.host
        .querySelector('form')!
        .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
    );
    await settle(15);
    expect(posted).toMatchObject({
      data: { message: 'hello' },
      backoff: { type: 'fixed', delay: 1250 },
      tags: ['mail', 'priority'],
      groupId: 'tenant-a',
      ttl: 60_000,
    });
    view.unmount();
  });
});
