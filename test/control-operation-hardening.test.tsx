import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { Benchmark } from '../src/pages/control/Benchmark';
import { DEFAULT_CONFIG } from '../src/pages/control/benchmark/engine';
import { useBenchmark } from '../src/pages/control/benchmark/useBenchmark';
import { ensureDom, renderHook, settle } from './domSetup';

ensureDom();

const realFetch = globalThis.fetch;
const realConfirm = globalThis.window.confirm;
const mounted = new Set<() => void>();

const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'content-type': 'application/json' } });

const benchmarkCounts = (over: Record<string, number> = {}) => ({
  waiting: 0,
  prioritized: 0,
  delayed: 0,
  active: 0,
  paused: 0,
  'waiting-children': 0,
  completed: 0,
  failed: 0,
  ...over,
});

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

function findButton(host: ParentNode, text: string): HTMLButtonElement {
  const button = [...host.querySelectorAll('button')].find((candidate) =>
    (candidate.textContent ?? '').includes(text)
  ) as HTMLButtonElement | undefined;
  if (!button) throw new Error(`No button containing "${text}"`);
  return button;
}

function _click(element: Element): void {
  act(() => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
}

function _dbPage(table: string, offset: number, rows: unknown[][], total: number) {
  return {
    ok: true,
    table,
    columns: ['id'],
    rows,
    rowids: rows.map((_, index) => offset + index + 1),
    truncatedCells: rows.map(() => [false]),
    total,
    limit: 50,
    offset,
    orderBy: null,
    dir: 'asc' as const,
    filter: null,
  };
}

function _dbExportResponse(
  table: string,
  csv: string,
  rows: number,
  cap: 'none' | 'rows' | 'bytes' = 'none',
  overrides: Record<string, string> = {}
): Response {
  const content = new TextEncoder().encode(csv);
  return new Response(content, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Length': String(content.byteLength),
      'X-Bunqueue-Db-Export-Version': '1',
      'X-Bunqueue-Db-Export-Table': encodeURIComponent(table),
      'X-Bunqueue-Db-Export-Rows': String(rows),
      'X-Bunqueue-Db-Export-Bytes': String(content.byteLength),
      'X-Bunqueue-Db-Export-Cap': cap,
      ...overrides,
    },
  });
}

beforeEach(() => {
  ensureDom();
  localStorage.removeItem('bq-dash-db-history');
  useConnectionStore.setState({
    baseUrl: 'http://server-a.test',
    token: 'alpha',
    agentToken: 'agent-alpha',
    refreshMs: 3000,
  });
});

afterEach(() => {
  for (const unmount of [...mounted]) unmount();
  globalThis.fetch = realFetch;
  globalThis.window.confirm = realConfirm;
  localStorage.removeItem('bq-dash-db-history');
  useConnectionStore.setState({
    baseUrl: '/api',
    token: '',
    agentToken: '',
    refreshMs: 3000,
  });
});

describe('Benchmark operation identity and lifecycle', () => {
  test('pins URL and bearer token before preflight and keeps them for the whole run', async () => {
    const preflight = deferred<Response>();
    const calls: Array<{ url: string; auth: string | null }> = [];
    let pulls = 0;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, auth: new Headers(init?.headers).get('authorization') });
      if (url === 'http://server-a.test/dashboard') return preflight.promise;
      if (url.endsWith('/counts')) {
        return Promise.resolve(json({ ok: true, counts: benchmarkCounts() }));
      }
      if (url.endsWith('/jobs/bulk')) {
        return Promise.resolve(json({ ok: true, ids: ['benchmark-own'] }));
      }
      if (url.endsWith('/pull-batch')) {
        pulls++;
        return Promise.resolve(
          json({
            ok: true,
            jobs: pulls === 1 ? [{ id: 'benchmark-own' }] : [],
            tokens: pulls === 1 ? ['lock-own'] : [],
          })
        );
      }
      if (url.endsWith('/heartbeat-batch')) {
        return Promise.resolve(json({ ok: true, data: { ok: true, count: 1 } }));
      }
      if (url.endsWith('/ack-batch')) return Promise.resolve(json({ ok: true }));
      return Promise.resolve(json({ ok: false, error: `unexpected ${url}` }, 500));
    }) as typeof fetch;

    const hook = renderHook(() => useBenchmark());
    let run!: Promise<void>;
    act(() => {
      run = hook.result.current.run({
        ...DEFAULT_CONFIG,
        total: 1,
        batch: 1,
        producers: 1,
        workers: 1,
        workerBatch: 1,
        processMs: 0,
      });
    });
    await settle(5);
    act(() => {
      useConnectionStore.setState({ baseUrl: 'http://server-b.test', token: 'bravo' });
    });
    await act(async () => {
      preflight.resolve(json({ ok: true }));
      await run;
    });

    expect(hook.result.current.phase).toBe('done');
    expect(calls.length).toBeGreaterThanOrEqual(5);
    expect(calls.every((call) => call.url.startsWith('http://server-a.test/'))).toBe(true);
    expect(calls.every((call) => call.auth === 'Bearer alpha')).toBe(true);
    hook.unmount();
  });

  test('uses a same-tick Run/Clean mutex and pins every cleanup request', async () => {
    const firstClean = deferred<Response>();
    const cleanCalls: Array<{ url: string; auth: string | null }> = [];
    let cleanCount = 0;
    const allCalls: string[] = [];
    globalThis.window.confirm = () => true;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      allCalls.push(url);
      if (url.endsWith('/clean')) {
        cleanCalls.push({ url, auth: new Headers(init?.headers).get('authorization') });
        cleanCount++;
        return cleanCount === 1
          ? firstClean.promise
          : Promise.resolve(json({ ok: true, count: 0 }));
      }
      if (url.endsWith('/counts')) {
        return Promise.resolve(json({ ok: true, counts: benchmarkCounts() }));
      }
      return Promise.resolve(json({ ok: true }));
    }) as typeof fetch;

    const view = render(createElement(Benchmark));
    const clean = findButton(view.host, 'Clean queue');
    const run = findButton(view.host, 'Run benchmark');
    act(() => {
      clean.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      run.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    await settle(5);
    act(() => {
      useConnectionStore.setState({ baseUrl: 'http://server-b.test', token: 'bravo' });
    });
    firstClean.resolve(json({ ok: true, count: 0 }));
    await settle(50);

    expect(cleanCalls).toHaveLength(3);
    expect(cleanCalls.every((call) => call.url.startsWith('http://server-a.test/'))).toBe(true);
    expect(cleanCalls.every((call) => call.auth === 'Bearer alpha')).toBe(true);
    expect(allCalls.some((url) => url.endsWith('/dashboard'))).toBe(false);
    expect(allCalls.some((url) => url.endsWith('/jobs/bulk'))).toBe(false);
  });
});
