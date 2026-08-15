import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { BqError } from '../src/lib/bq';
import { jobDataReadOnlyReason } from '../src/pages/control/job/JobDataEditor';
import { loadJobForLookup } from '../src/pages/control/JobInspector';
import { ensureDom } from './domSetup';

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
});
