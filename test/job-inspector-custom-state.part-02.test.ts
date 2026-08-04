import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { BqError } from '../src/lib/bq';
import {
  buildStacktracePreview,
  JobInspector,
  loadJobForLookup,
} from '../src/pages/control/JobInspector';
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
});
