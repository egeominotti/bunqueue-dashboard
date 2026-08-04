import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { BqError } from '../src/lib/bq';
import {
  buildStacktracePreview,
  JobInspector,
  loadJobForLookup,
} from '../src/pages/control/JobInspector';
import { jobDataReadOnlyReason } from '../src/pages/control/job/JobDataEditor';
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
  test('data editing fails closed for every public or reserved Flow marker', () => {
    const ordinary = { data: { value: 1 }, parentId: null, childrenIds: [] };
    expect(jobDataReadOnlyReason('waiting', ordinary)).toBeNull();
    expect(jobDataReadOnlyReason('active', ordinary)).toContain('leaves the runnable queue');

    const flowShapes = [
      { ...ordinary, parentId: 'parent' },
      { ...ordinary, childrenIds: ['child'] },
      ...['__parentId', '__parentQueue', '__childrenIds', '__flowParentId', '__flowParentIds'].map(
        (key) => ({ ...ordinary, data: { value: 1, [key]: 'structural' } })
      ),
    ];
    for (const job of flowShapes) {
      expect(jobDataReadOnlyReason('waiting', job)).toContain('Flow jobs');
    }
  });

  test('resolves the internal id again so the live state drives every panel', async () => {
    const paths: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = String(input);
      paths.push(path);
      if (path.endsWith('/jobs/custom/order-42')) {
        // Exact v2.8.55 behavior: this route returns the stored job but does not
        // inject the state that GET /jobs/:id resolves through QueueManager.
        return json({ ok: true, job: { id: 'internal-7', customId: 'order-42' } });
      }
      if (path.endsWith('/jobs/internal-7')) {
        return json({
          ok: true,
          job: { id: 'internal-7', customId: 'order-42', queue: 'orders', state: 'waiting' },
        });
      }
      return json({ ok: false, error: 'unexpected request' }, 500);
    }) as typeof fetch;

    const job = await loadJobForLookup('order-42', 'custom');

    expect(paths).toEqual(['/api/jobs/custom/order-42', '/api/jobs/internal-7']);
    expect(job).toMatchObject({ id: 'internal-7', state: 'waiting' });
  });

  test('a normal id lookup remains a single request', async () => {
    const paths: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      paths.push(String(input));
      return json({ ok: true, job: { id: 'internal-8', queue: 'orders', state: 'active' } });
    }) as typeof fetch;

    expect(await loadJobForLookup('internal-8', 'id')).toMatchObject({ state: 'active' });
    expect(paths).toEqual(['/api/jobs/internal-8']);
  });

  test('keeps opaque internal punctuation raw and rejects dot retargeting before fetch', async () => {
    const paths: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      paths.push(String(input));
      return json({
        ok: true,
        job: { id: 'job:@+', queue: 'orders', state: 'waiting' },
      });
    }) as typeof fetch;

    expect(await loadJobForLookup('job:@+', 'id')).toMatchObject({ id: 'job:@+' });
    expect(paths).toEqual(['/api/jobs/job:@+']);

    await expect(loadJobForLookup('.', 'id')).rejects.toThrow('path traversal segment');
    await expect(loadJobForLookup('..', 'custom')).rejects.toThrow('path traversal segment');
    expect(paths).toHaveLength(1);
  });

  test('both custom-id requests use one immutable backend and credential snapshot', async () => {
    useConnectionStore.setState({ baseUrl: 'https://server-a.test/api', token: 'token-a' });
    const calls: Array<{ url: string; auth: string | null }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = { url: String(input), auth: authorization(init) };
      calls.push(call);
      if (call.url.endsWith('/jobs/custom/order-42')) {
        // Change the global store before the canonical fetch. The standalone
        // operation must still finish entirely against its captured target.
        useConnectionStore.setState({ baseUrl: 'https://server-b.test/api', token: 'token-b' });
        return json({ ok: true, job: { id: 'internal-a', customId: 'order-42' } });
      }
      return json({ ok: true, job: { id: 'internal-a', queue: 'orders', state: 'active' } });
    }) as typeof fetch;

    expect(await loadJobForLookup('order-42', 'custom')).toMatchObject({ id: 'internal-a' });
    expect(calls).toEqual([
      {
        url: 'https://server-a.test/api/jobs/custom/order-42',
        auth: 'Bearer token-a',
      },
      { url: 'https://server-a.test/api/jobs/internal-a', auth: 'Bearer token-a' },
    ]);
  });

  test('a raw protocol-relative target is never used as a request authority', async () => {
    // Direct setState bypasses the public setter and models legacy/corrupt
    // in-memory data. The lookup transport must retain getBaseUrl()'s defense.
    useConnectionStore.setState({ baseUrl: '//attacker.test', token: 'token-a' });
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return json({ ok: true, job: { id: 'safe-job', queue: 'safe', state: 'waiting' } });
    }) as typeof fetch;

    expect(await loadJobForLookup('safe-job', 'id')).toMatchObject({ id: 'safe-job' });
    expect(calls).toEqual(['/api/jobs/safe-job']);
  });

  test('transport keeps timeout, malformed JSON, empty body, and 401 auth semantics', async () => {
    ensureDom();
    useConnectionStore.setState({ baseUrl: '/api', token: 'token-a' });
    let authDetail: { scope?: string; auth?: string; target?: string } | undefined;
    const onAuth = (event: Event) => {
      authDetail = (event as CustomEvent<{ scope?: string; auth?: string; target?: string }>)
        .detail;
    };
    window.addEventListener('auth:required', onAuth);

    try {
      globalThis.fetch = (async () =>
        json({ ok: false, error: 'Unauthorized' }, 401)) as typeof fetch;
      let unauthorized: unknown;
      try {
        await loadJobForLookup('private-job', 'id');
      } catch (error) {
        unauthorized = error;
      }
      expect(unauthorized).toBeInstanceOf(BqError);
      expect(unauthorized).toMatchObject({ message: 'Unauthorized', status: 401 });
      expect(authDetail).toEqual({
        scope: 'server',
        auth: 'Bearer token-a',
        target: '/api',
      });

      globalThis.fetch = (async () => new Response('{broken', { status: 200 })) as typeof fetch;
      await expect(loadJobForLookup('broken-job', 'id')).rejects.toMatchObject({
        message: 'Invalid JSON response (HTTP 200)',
        status: 200,
      });

      globalThis.fetch = (async () => new Response('', { status: 200 })) as typeof fetch;
      await expect(loadJobForLookup('empty-job', 'id')).rejects.toMatchObject({
        message: 'Invalid job response: expected an object envelope',
        status: 200,
      });

      globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) return reject(new Error('missing request signal'));
          const rejectAbort = () => reject(signal.reason);
          if (signal.aborted) rejectAbort();
          else signal.addEventListener('abort', rejectAbort, { once: true });
        })) as typeof fetch;
      await expect(loadJobForLookup('slow-job', 'id', { timeoutMs: 5 })).rejects.toMatchObject({
        message: 'Request timed out',
        status: 0,
      });
    } finally {
      window.removeEventListener('auth:required', onAuth);
    }
  });

  test('malformed 2xx lookup envelopes fail readably and never request /undefined', async () => {
    const paths: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      paths.push(String(input));
      return json({ ok: true, job: {} });
    }) as typeof fetch;

    await expect(loadJobForLookup('order-42', 'custom')).rejects.toMatchObject({
      message: 'Invalid job response: job.id must be a non-empty string',
      status: 200,
    });
    expect(paths).toEqual(['/api/jobs/custom/order-42']);
    expect(paths.some((path) => path.includes('/undefined'))).toBeFalse();

    globalThis.fetch = (async () => json({ ok: true })) as typeof fetch;
    await expect(loadJobForLookup('internal-8', 'id')).rejects.toMatchObject({
      message: 'Invalid job response: expected { ok: true, job }',
      status: 200,
    });
  });

  test('a custom-id index response must belong to the requested custom id', async () => {
    const paths: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      paths.push(String(input));
      return json({ ok: true, job: { id: 'wrong-job', customId: 'different-key' } });
    }) as typeof fetch;

    await expect(loadJobForLookup('wanted-key', 'custom')).rejects.toMatchObject({
      message: 'Invalid job response: expected job.customId "wanted-key"',
      status: 200,
    });
    // Never follow an uncorrelated index entry into its canonical job route.
    expect(paths).toEqual(['/api/jobs/custom/wanted-key']);
  });

  test('every structured field consumed by the inspector is runtime-validated', async () => {
    const base = { id: 'validated-job', queue: 'q', state: 'failed' };
    const cases: Array<{ patch: Record<string, unknown>; message: string }> = [
      {
        patch: { queue: { hostile: true } },
        message: 'canonical job.queue must be a non-empty string',
      },
      {
        patch: { stacktrace: 'not-an-array' },
        message: 'job.stacktrace must be a string array or null',
      },
      {
        patch: { timeline: [{ state: 'failed', timestamp: 'now' }] },
        message: 'job.timeline[0].timestamp must be a finite number',
      },
      { patch: { customId: {} }, message: 'job.customId must be a string or null' },
      { patch: { parentId: 42 }, message: 'job.parentId must be a string or null' },
      { patch: { childrenIds: ['child', 42] }, message: 'job.childrenIds must be a string array' },
      {
        patch: { maxAttempts: 'forever' },
        message: 'job.maxAttempts must be a valid safe integer',
      },
      {
        patch: { backoffConfig: { type: 'fixed', delay: 'soon' } },
        message: 'job.backoffConfig.delay must be a valid safe integer',
      },
    ];

    for (const { patch, message } of cases) {
      globalThis.fetch = (async () =>
        json({ ok: true, job: { ...base, ...patch } })) as typeof fetch;
      let failure: unknown;
      try {
        await loadJobForLookup(base.id, 'id');
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(BqError);
      expect((failure as BqError).message).toContain(message);
      expect((failure as BqError).status).toBe(200);
    }
  });

  test('accepts Bunqueue-sized stacks but keeps their rendered preview bounded', async () => {
    const stacktrace = Array.from({ length: 10_000 }, (_, index) => `frame-${index}`);
    globalThis.fetch = (async () =>
      json({
        ok: true,
        job: { id: 'large-stack', queue: 'q', state: 'failed', stacktrace },
      })) as typeof fetch;

    const loaded = await loadJobForLookup('large-stack', 'id');
    expect(loaded.stacktrace).toHaveLength(10_000);
    const preview = buildStacktracePreview(loaded.stacktrace ?? []);
    expect(preview.displayedLines).toBe(100);
    expect(preview.totalLines).toBe(10_000);
    expect(preview.truncated).toBeTrue();
    expect(preview.text).not.toContain('frame-100');

    const longLine = buildStacktracePreview(['x'.repeat(300 * 1024)]);
    expect(longLine.text.length).toBe(256 * 1024);
    expect(longLine.truncated).toBeTrue();
    const astralBoundary = buildStacktracePreview([`${'a'.repeat(256 * 1024 - 1)}💥not-visible`]);
    expect(Array.from(astralBoundary.text)).toHaveLength(256 * 1024);
    expect(astralBoundary.text.endsWith('💥')).toBeTrue();
    expect(astralBoundary.truncated).toBeTrue();

    globalThis.fetch = (async () =>
      json({
        ok: true,
        job: {
          id: 'too-many-frames',
          queue: 'q',
          state: 'failed',
          stacktrace: Array.from({ length: 10_001 }, () => 'frame'),
        },
      })) as typeof fetch;
    await expect(loadJobForLookup('too-many-frames', 'id')).rejects.toThrow(
      "exceeds Bunqueue's 10000-entry limit"
    );
  });

  test('a malformed stacktrace becomes a readable lookup error instead of crashing React', async () => {
    ensureDom();
    globalThis.fetch = (async () =>
      json({
        ok: true,
        job: { id: 'crashy-job', queue: 'q', state: 'failed', stacktrace: 'not-an-array' },
      })) as typeof fetch;

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      act(() =>
        root.render(
          createElement(
            MemoryRouter,
            { initialEntries: ['/job?id=crashy-job'] },
            createElement(JobInspector)
          )
        )
      );
      await settle(30);

      expect(host.textContent).toContain(
        'Invalid job response: job.stacktrace must be a string array or null'
      );
      expect(host.textContent).toContain('No job loaded');
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  test('the canonical lookup stage requires the requested id and a live state', async () => {
    const paths: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = String(input);
      paths.push(path);
      if (path.endsWith('/jobs/custom/order-42')) {
        return json({ ok: true, job: { id: 'internal-7', customId: 'order-42' } });
      }
      return json({ ok: true, job: { id: 'internal-7' } });
    }) as typeof fetch;

    await expect(loadJobForLookup('order-42', 'custom')).rejects.toMatchObject({
      message: 'Invalid job response: canonical job.state must be a non-empty string',
      status: 200,
    });
    expect(paths).toEqual(['/api/jobs/custom/order-42', '/api/jobs/internal-7']);

    globalThis.fetch = (async () =>
      json({ ok: true, job: { id: 'wrong-id', state: 'waiting' } })) as typeof fetch;
    await expect(loadJobForLookup('requested-id', 'id')).rejects.toMatchObject({
      message: 'Invalid job response: expected job.id "requested-id"',
      status: 200,
    });
  });

  test('after canonicalization a second UI lookup uses id mode', async () => {
    ensureDom();
    const paths: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = String(input);
      paths.push(path);
      if (path.endsWith('/jobs/custom/order-42')) {
        return json({ ok: true, job: { id: 'internal-7', customId: 'order-42' } });
      }
      if (path.endsWith('/jobs/internal-7/logs')) {
        return json({ ok: true, data: { logs: [], count: 0 } });
      }
      if (path.endsWith('/jobs/internal-7')) {
        return json({
          ok: true,
          job: { id: 'internal-7', customId: 'order-42', queue: 'orders', state: 'waiting' },
        });
      }
      return json({ ok: false, error: `unexpected request: ${path}` }, 500);
    }) as typeof fetch;

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      act(() =>
        root.render(
          createElement(
            MemoryRouter,
            { initialEntries: ['/job?custom=order-42'] },
            createElement(JobInspector)
          )
        )
      );
      await settle(100);
      const mode = host.querySelector('select[aria-label="Lookup mode"]') as HTMLSelectElement;
      const lookupButton = [...host.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === 'Look up'
      );
      if (!lookupButton) throw new Error('Look up button not found');

      expect(paths.filter((path) => !path.endsWith('/logs'))).toEqual([
        '/api/jobs/custom/order-42',
        '/api/jobs/internal-7',
      ]);
      expect(mode.value).toBe('id');
      const canonicalInput = host.querySelector('input[aria-label="Job ID"]') as HTMLInputElement;
      expect(canonicalInput.value).toBe('internal-7');

      act(() => lookupButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
      await settle(100);
      expect(paths.filter((path) => !path.endsWith('/logs'))).toEqual([
        '/api/jobs/custom/order-42',
        '/api/jobs/internal-7',
        '/api/jobs/internal-7',
      ]);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

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
      expect(host.textContent).toContain('Cancel/delete/discard: Unavailable in Bunqueue v2.8.57');
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
