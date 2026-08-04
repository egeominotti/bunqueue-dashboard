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
  test('unmount aborts a slow lookup and cannot mutate search params afterward', async () => {
    ensureDom();
    const slow = deferred<Response>();
    let requestSignal: AbortSignal | undefined;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal;
      // Deliberately ignore abort and resolve later: the generation guard must
      // still protect React state and the router from an uncooperative transport.
      return slow.promise;
    }) as typeof fetch;

    let currentSearch = '';
    function Screen({ showInspector }: { showInspector: boolean }) {
      currentSearch = useLocation().search;
      return showInspector ? createElement(JobInspector) : null;
    }
    const app = (showInspector: boolean) =>
      createElement(
        MemoryRouter,
        { initialEntries: ['/job?id=slow-job'] },
        createElement(Screen, { showInspector })
      );

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      act(() => root.render(app(true)));
      expect(requestSignal).toBeDefined();
      expect(requestSignal?.aborted).toBeFalse();

      // Keep the router mounted so a stale setSearchParams call remains visible.
      act(() => root.render(app(false)));
      expect(requestSignal?.aborted).toBeTrue();
      slow.resolve(
        json({
          ok: true,
          job: { id: 'canonical-after-unmount', queue: 'q', state: 'waiting' },
        })
      );
      await settle(10);

      expect(currentSearch).toBe('?id=slow-job');
      expect(host.textContent).toBe('');
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  test('removing both lookup params aborts and fully resets a still-mounted inspector', async () => {
    ensureDom();
    const slow = deferred<Response>();
    let slowSignal: AbortSignal | undefined;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/jobs/loaded-job/logs')) {
        return Promise.resolve(json({ ok: true, data: { logs: ['loaded log'], count: 1 } }));
      }
      if (url.endsWith('/jobs/loaded-job')) {
        return Promise.resolve(
          json({ ok: true, job: { id: 'loaded-job', queue: 'q', state: 'waiting' } })
        );
      }
      if (url.endsWith('/jobs/slow-job')) {
        slowSignal = init?.signal;
        // Ignore abort so the generation check is exercised independently.
        return slow.promise;
      }
      return Promise.resolve(json({ ok: false, error: `unexpected request: ${url}` }, 500));
    }) as typeof fetch;

    let navigate!: ReturnType<typeof useNavigate>;
    let currentSearch = '';
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
          createElement(
            MemoryRouter,
            { initialEntries: ['/job?id=loaded-job'] },
            createElement(Screen)
          )
        )
      );
      await settle(50);
      expect(host.textContent).toContain('loaded-job');
      expect(host.textContent).toContain('loaded log');

      act(() => navigate('/job?id=slow-job'));
      expect(slowSignal).toBeDefined();
      expect(slowSignal?.aborted).toBeFalse();

      // The component and router remain mounted; only the URL lookup key goes.
      act(() => navigate('/job'));
      expect(slowSignal?.aborted).toBeTrue();
      slow.resolve(json({ ok: true, job: { id: 'slow-job', queue: 'q', state: 'active' } }));
      await settle(20);

      expect(currentSearch).toBe('');
      expect(host.textContent).toContain('No job loaded');
      expect(host.textContent).not.toContain('loaded-job');
      expect(host.textContent).not.toContain('loaded log');
      expect(host.textContent).not.toContain('slow-job');
      expect(host.textContent).not.toContain('Cancel (delete)');
      const input = host.querySelector('input[aria-label="Job ID"]') as HTMLInputElement;
      expect(input.value).toBe('');
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  test('an internally cleared 404 URL keeps the not-found terminal state', async () => {
    ensureDom();
    let currentSearch = '';
    let requests = 0;
    globalThis.fetch = (() => {
      requests += 1;
      return Promise.resolve(json({ ok: false, error: 'Job not found' }, 404));
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
            { initialEntries: ['/job?id=missing-job'] },
            createElement(Screen)
          )
        )
      );
      await settle(30);

      expect(requests).toBe(1);
      expect(currentSearch).toBe('');
      expect(host.textContent).toContain('Job not found');
      expect(host.textContent).not.toContain('No job loaded');
      const input = host.querySelector('input[aria-label="Job ID"]') as HTMLInputElement;
      expect(input.value).toBe('missing-job');
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
});
