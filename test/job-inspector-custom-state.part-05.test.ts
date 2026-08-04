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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function authorization(init?: RequestInit): string | null {
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
  test('a connection change aborts custom resolution and restarts wholly on the new target', async () => {
    ensureDom();
    useConnectionStore.setState({ baseUrl: 'https://server-a.test/api', token: 'token-a' });
    const oldCustom = deferred<Response>();
    const calls: Array<{ url: string; auth: string | null; signal?: AbortSignal }> = [];
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const call = {
        url: String(input),
        auth: authorization(init),
        signal: init?.signal,
      };
      calls.push(call);
      if (call.url === 'https://server-a.test/api/jobs/custom/order-42') {
        // Ignore abort to prove the generation guard independently as well.
        return oldCustom.promise;
      }
      if (call.url === 'https://server-b.test/api/jobs/custom/order-42') {
        return Promise.resolve(json({ ok: true, job: { id: 'internal-b', customId: 'order-42' } }));
      }
      if (call.url === 'https://server-b.test/api/jobs/internal-b') {
        return Promise.resolve(
          json({
            ok: true,
            job: {
              id: 'internal-b',
              customId: 'order-42',
              queue: 'new-target',
              state: 'active',
            },
          })
        );
      }
      if (call.url === 'https://server-b.test/api/jobs/internal-b/logs') {
        return Promise.resolve(json({ ok: true, data: { logs: [], count: 0 } }));
      }
      return Promise.resolve(json({ ok: false, error: `unexpected request: ${call.url}` }, 500));
    }) as typeof fetch;

    let currentSearch = '';
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
            { initialEntries: ['/job?custom=order-42'] },
            createElement(Screen)
          )
        )
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]?.signal?.aborted).toBeFalse();

      act(() =>
        useConnectionStore.setState({
          baseUrl: 'https://server-b.test/api',
          token: 'token-b',
        })
      );
      expect(calls[0]?.signal?.aborted).toBeTrue();

      oldCustom.resolve(
        json({ ok: true, job: { id: 'internal-a', customId: 'order-42', state: 'failed' } })
      );
      await settle(100);

      const jobCalls = calls.filter((call) => !call.url.endsWith('/logs'));
      expect(jobCalls.map((call) => call.url)).toEqual([
        'https://server-a.test/api/jobs/custom/order-42',
        'https://server-b.test/api/jobs/custom/order-42',
        'https://server-b.test/api/jobs/internal-b',
      ]);
      expect(jobCalls.map((call) => call.auth)).toEqual([
        'Bearer token-a',
        'Bearer token-b',
        'Bearer token-b',
      ]);
      expect(calls.some((call) => call.url.includes('internal-a'))).toBeFalse();
      expect(currentSearch).toBe('?id=internal-b');
      expect(host.textContent).toContain('internal-b');
      expect(host.textContent).toContain('active');
      expect(host.textContent).not.toContain('failed');
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  test('manual lookup cannot release a pending mutation lock or send a second POST', async () => {
    ensureDom();
    const slowPromote = deferred<Response>();
    let postCalls = 0;
    let canonicalReads = 0;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (method === 'POST' && url.endsWith('/jobs/racy-job/promote')) {
        postCalls += 1;
        return slowPromote.promise;
      }
      if (url.endsWith('/jobs/racy-job/logs')) {
        return Promise.resolve(json({ ok: true, data: { logs: [], count: 0 } }));
      }
      if (url.endsWith('/jobs/racy-job')) {
        canonicalReads += 1;
        return Promise.resolve(
          json({
            ok: true,
            job: {
              id: 'racy-job',
              queue: 'q',
              state: canonicalReads === 1 ? 'delayed' : 'waiting',
            },
          })
        );
      }
      return Promise.resolve(json({ ok: false, error: `unexpected request: ${url}` }, 500));
    }) as typeof fetch;

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      act(() =>
        root.render(
          createElement(
            MemoryRouter,
            { initialEntries: ['/job?id=racy-job'] },
            createElement(JobInspector)
          )
        )
      );
      await settle(50);
      const promote = [...host.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('Promote (run now)')
      );
      const lookupButton = [...host.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === 'Look up'
      );
      const input = host.querySelector('input[aria-label="Job ID"]') as HTMLInputElement;
      if (!promote || !lookupButton || !input) throw new Error('Inspector controls not found');

      act(() => promote.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
      await settle(0);
      expect(postCalls).toBe(1);
      expect(lookupButton.disabled).toBeTrue();
      expect(promote.disabled).toBeTrue();

      // Exercise both manual lookup paths and another action click while the
      // first POST is unresolved. None may invalidate/release its mutex.
      act(() => {
        input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        lookupButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        promote.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      });
      await settle(0);
      expect(postCalls).toBe(1);
      expect(canonicalReads).toBe(1);

      slowPromote.resolve(json({ ok: true }));
      await settle(50);

      expect(postCalls).toBe(1);
      expect(canonicalReads).toBe(2);
      expect(host.textContent).toContain('Promote ✓');
      expect(lookupButton.disabled).toBeFalse();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
});
