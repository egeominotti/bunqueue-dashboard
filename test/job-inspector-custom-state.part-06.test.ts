import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
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

function _authorization(init?: RequestInit): string | null {
  return new Headers(init?.headers).get('Authorization');
}

async function setInputValue(element: HTMLInputElement, value: string): Promise<void> {
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
  test('failed cross-job navigation clears the old snapshot and every old action', async () => {
    ensureDom();
    let navigate!: ReturnType<typeof useNavigate>;
    let currentSearch = '';
    let postCalls = 0;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (method === 'POST') {
        postCalls += 1;
        return Promise.resolve(json({ ok: true }));
      }
      if (url.endsWith('/jobs/job-a/logs')) {
        return Promise.resolve(json({ ok: true, data: { logs: [], count: 0 } }));
      }
      if (url.endsWith('/jobs/job-a')) {
        return Promise.resolve(
          json({ ok: true, job: { id: 'job-a', queue: 'queue-a', state: 'delayed' } })
        );
      }
      if (url.endsWith('/jobs/job-b')) {
        return Promise.resolve(json({ ok: false, error: 'B unavailable' }, 503));
      }
      return Promise.resolve(json({ ok: false, error: `unexpected request: ${url}` }, 500));
    }) as typeof fetch;

    function Screen() {
      navigate = useNavigate();
      currentSearch = useLocation().search;
      return createElement(JobInspector);
    }

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      act(() =>
        root.render(
          createElement(MemoryRouter, { initialEntries: ['/job?id=job-a'] }, createElement(Screen))
        )
      );
      await settle(50);
      expect(host.textContent).toContain('queue-a');
      expect(host.textContent).toContain('Promote (run now)');

      act(() => navigate('/job?id=job-b'));
      await settle(30);

      expect(currentSearch).toBe('?id=job-b');
      expect(host.textContent).toContain('B unavailable');
      expect(host.textContent).not.toContain('queue-a');
      expect(host.textContent).not.toContain('Promote (run now)');
      expect(postCalls).toBe(0);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  test('a manual cross-job lookup makes the new URL authoritative before clearing the old job', async () => {
    ensureDom();
    const jobB = deferred<Response>();
    const canonicalReads: string[] = [];
    let currentSearch = '';
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/logs')) {
        return Promise.resolve(json({ ok: true, data: { logs: [], count: 0 } }));
      }
      if (url.endsWith('/jobs/job-a')) {
        canonicalReads.push('a');
        return Promise.resolve(
          json({ ok: true, job: { id: 'job-a', queue: 'queue-a', state: 'delayed' } })
        );
      }
      if (url.endsWith('/jobs/job-b')) {
        canonicalReads.push('b');
        return jobB.promise;
      }
      return Promise.resolve(json({ ok: false, error: `unexpected request: ${url}` }, 500));
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
          createElement(MemoryRouter, { initialEntries: ['/job?id=job-a'] }, createElement(Screen))
        )
      );
      await settle(50);
      const input = host.querySelector('input[aria-label="Job ID"]') as HTMLInputElement;
      const lookupButton = [...host.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === 'Look up'
      );
      if (!input || !lookupButton) throw new Error('Lookup controls not found');

      await setInputValue(input, 'job-b');
      expect(input.value).toBe('job-b');
      act(() => lookupButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
      await settle(10);

      expect(currentSearch).toBe('?id=job-b');
      expect(canonicalReads).toEqual(['a', 'b']);
      expect(host.textContent).not.toContain('queue-a');

      jobB.resolve(json({ ok: false, error: 'B unavailable' }, 503));
      await settle(30);

      expect(currentSearch).toBe('?id=job-b');
      expect(canonicalReads).toEqual(['a', 'b']);
      expect(host.textContent).toContain('B unavailable');
      expect(host.textContent).not.toContain('queue-a');
      expect(host.textContent).not.toContain('Promote (run now)');
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  test('an old mutation settling after failed navigation cannot reactivate the old job', async () => {
    ensureDom();
    const slowPromote = deferred<Response>();
    let navigate!: ReturnType<typeof useNavigate>;
    let currentSearch = '';
    let postCalls = 0;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (method === 'POST' && url.endsWith('/jobs/job-a/promote')) {
        postCalls += 1;
        return slowPromote.promise;
      }
      if (url.endsWith('/jobs/job-a/logs')) {
        return Promise.resolve(json({ ok: true, data: { logs: [], count: 0 } }));
      }
      if (url.endsWith('/jobs/job-a')) {
        return Promise.resolve(
          json({ ok: true, job: { id: 'job-a', queue: 'queue-a', state: 'delayed' } })
        );
      }
      if (url.endsWith('/jobs/job-b')) {
        return Promise.resolve(json({ ok: false, error: 'B unavailable' }, 503));
      }
      return Promise.resolve(json({ ok: false, error: `unexpected request: ${url}` }, 500));
    }) as typeof fetch;

    function Screen() {
      navigate = useNavigate();
      currentSearch = useLocation().search;
      return createElement(JobInspector);
    }

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      act(() =>
        root.render(
          createElement(MemoryRouter, { initialEntries: ['/job?id=job-a'] }, createElement(Screen))
        )
      );
      await settle(50);
      const promote = [...host.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('Promote (run now)')
      );
      if (!promote) throw new Error('Promote button not found');

      act(() => promote.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
      await settle(0);
      expect(postCalls).toBe(1);

      act(() => navigate('/job?id=job-b'));
      await settle(30);
      expect(currentSearch).toBe('?id=job-b');
      expect(host.textContent).toContain('B unavailable');
      expect(host.textContent).not.toContain('queue-a');
      expect(host.textContent).not.toContain('Promote (run now)');

      slowPromote.resolve(json({ ok: true }));
      await settle(30);

      expect(currentSearch).toBe('?id=job-b');
      expect(host.textContent).toContain('B unavailable');
      expect(host.textContent).not.toContain('queue-a');
      expect(host.textContent).not.toContain('Promote (run now)');
      expect(postCalls).toBe(1);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
});
