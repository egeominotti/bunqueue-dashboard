import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { JobInspector } from '../src/pages/control/JobInspector';
import { ensureDom, settle } from './domSetup';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  useConnectionStore.setState({ baseUrl: '/api', token: '', agentToken: '' });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  useConnectionStore.setState({ baseUrl: '/api', token: '', agentToken: '' });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function _deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function _authorization(init?: RequestInit): string | null {
  return new Headers(init?.headers).get('Authorization');
}

async function _setInputValue(element: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    element.focus();
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(
      element,
      value
    );
    element.dispatchEvent(
      new window.InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: value,
      })
    );
    element.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}

describe('Job Inspector custom-id lookup', () => {
  test('a waiting flow child exposes neither Cancel nor Discard and sends no destructive mutation', async () => {
    ensureDom();
    let currentSearch = '';
    let deletes = 0;
    let discards = 0;
    let dataUpdates = 0;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? 'GET') === 'DELETE') {
        deletes += 1;
        return Promise.resolve(json({ ok: true }));
      }
      if (init?.method === 'POST' && url.endsWith('/jobs/waiting-job/discard')) {
        discards += 1;
        return Promise.resolve(json({ ok: true }));
      }
      if (init?.method === 'PUT' && url.endsWith('/jobs/waiting-job/data')) {
        dataUpdates += 1;
        return Promise.resolve(json({ ok: true }));
      }
      if (url.endsWith('/jobs/waiting-job/logs')) {
        return Promise.resolve(json({ ok: true, data: { logs: [], count: 0 } }));
      }
      return Promise.resolve(
        json({
          ok: true,
          job: {
            id: 'waiting-job',
            queue: 'q',
            state: 'waiting',
            parentId: 'parent-job',
            childrenIds: [],
            dependsOn: [],
            data: {
              value: 1,
              __parentId: 'parent-job',
              __parentQueue: 'parent-q',
            },
          },
        })
      );
    }) as typeof fetch;

    function Screen() {
      currentSearch = useLocation().search;
      return createElement(JobInspector);
    }

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      act(() =>
        root.render(
          createElement(
            MemoryRouter,
            { initialEntries: ['/job?id=waiting-job'] },
            createElement(Screen)
          )
        )
      );
      await settle(30);
      const cancel = [...host.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('Cancel (delete)')
      );
      expect(cancel).toBeUndefined();
      expect(deletes).toBe(0);
      expect(discards).toBe(0);
      expect(dataUpdates).toBe(0);
      expect(currentSearch).toBe('?id=waiting-job');
      expect(host.textContent).toContain('Cancel/delete/discard: Unavailable in Bunqueue v2.9.0');
      expect(host.textContent).not.toContain('Discard (to DLQ)');
      expect(host.textContent).not.toContain('Save data');
      expect(host.textContent).toContain('Data is read-only for Flow jobs');
      expect(
        host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Job data JSON"]')?.readOnly
      ).toBeTrue();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  test('failed jobs expose no DLQ retry action and cannot issue its POST', async () => {
    ensureDom();
    let currentSearch = '';
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ url, method, ...(typeof init?.body === 'string' ? { body: init.body } : {}) });
      if (url.endsWith('/jobs/failed-job/logs')) {
        return Promise.resolve(json({ ok: true, data: { logs: [], count: 0 } }));
      }
      if (url.endsWith('/jobs/failed-job') && method === 'GET') {
        return Promise.resolve(
          json({
            ok: true,
            job: {
              id: 'failed-job',
              queue: 'q',
              state: 'failed',
              parentId: null,
              childrenIds: [],
              dependsOn: [],
            },
          })
        );
      }
      return Promise.resolve(
        json({ ok: false, error: `unexpected request: ${method} ${url}` }, 500)
      );
    }) as typeof fetch;

    function Screen() {
      currentSearch = useLocation().search;
      return createElement(JobInspector);
    }

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      act(() =>
        root.render(
          createElement(
            MemoryRouter,
            { initialEntries: ['/job?id=failed-job'] },
            createElement(Screen)
          )
        )
      );
      await settle(30);
      expect(host.textContent).not.toContain('Retry from DLQ');
      expect(host.textContent).not.toContain('Requeue');
      expect(calls.filter((call) => call.method === 'POST')).toEqual([]);
      expect(calls.some((call) => call.method === 'DELETE')).toBeFalse();
      expect(currentSearch).toBe('?id=failed-job');
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
});
