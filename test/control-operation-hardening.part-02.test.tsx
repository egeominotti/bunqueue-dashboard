import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
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

function _render(element: ReactElement) {
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

function _findButton(host: ParentNode, text: string): HTMLButtonElement {
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
  test('Stop during simulated processing prevents a later ACK and pull', async () => {
    const calls: string[] = [];
    let pulls = 0;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/dashboard')) return Promise.resolve(json({ ok: true }));
      if (url.endsWith('/counts')) {
        return Promise.resolve(json({ ok: true, counts: benchmarkCounts() }));
      }
      if (url.endsWith('/jobs/bulk')) {
        return Promise.resolve(json({ ok: true, ids: ['benchmark-own'] }));
      }
      if (url.endsWith('/pull-batch')) {
        pulls++;
        return Promise.resolve(
          json({ ok: true, jobs: [{ id: 'benchmark-own' }], tokens: ['lock-own'] })
        );
      }
      if (url.endsWith('/ack-batch')) return Promise.resolve(json({ ok: true }));
      return Promise.resolve(json({ ok: true }));
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
        processMs: 500,
      });
    });
    await settle(20);
    act(() => hook.result.current.stop());
    await act(async () => run);

    expect(pulls).toBe(1);
    expect(calls.some((url) => url.endsWith('/ack-batch'))).toBe(false);
    expect(calls.some((url) => url.endsWith('/move-to-wait'))).toBe(true);
    expect(hook.result.current.phase).toBe('stopped');
    hook.unmount();
  });

  test('Stop during heartbeat returns the owned job to waiting before finishing', async () => {
    const heartbeat = deferred<Response>();
    let acknowledgements = 0;
    let retries = 0;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/dashboard')) return Promise.resolve(json({ ok: true }));
      if (url.endsWith('/counts')) {
        return Promise.resolve(json({ ok: true, counts: benchmarkCounts() }));
      }
      if (url.endsWith('/jobs/bulk')) {
        return Promise.resolve(json({ ok: true, ids: ['benchmark-own'] }));
      }
      if (url.endsWith('/pull-batch')) {
        return Promise.resolve(
          json({ ok: true, jobs: [{ id: 'benchmark-own' }], tokens: ['lock-own'] })
        );
      }
      if (url.endsWith('/heartbeat-batch')) return heartbeat.promise;
      if (url.endsWith('/ack-batch')) {
        acknowledgements += 1;
        return Promise.resolve(json({ ok: true }));
      }
      if (url.endsWith('/move-to-wait')) {
        retries += 1;
        return Promise.resolve(json({ ok: true }));
      }
      return Promise.resolve(json({ ok: true }));
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
    await settle(15);
    act(() => hook.result.current.stop());
    heartbeat.resolve(json({ ok: true, data: { ok: true, count: 1 } }));
    await act(async () => run);

    expect(acknowledgements).toBe(0);
    expect(retries).toBe(1);
    expect(hook.result.current.phase).toBe('stopped');
    hook.unmount();
  });

  test('unmount while pull is pending compensates the admitted job without ACK or another pull', async () => {
    const pull = deferred<Response>();
    const calls: string[] = [];
    let pulls = 0;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/dashboard')) return Promise.resolve(json({ ok: true }));
      if (url.endsWith('/counts')) {
        return Promise.resolve(json({ ok: true, counts: benchmarkCounts() }));
      }
      if (url.endsWith('/jobs/bulk')) {
        return Promise.resolve(json({ ok: true, ids: ['benchmark-own'] }));
      }
      if (url.endsWith('/pull-batch')) {
        pulls++;
        return pull.promise;
      }
      if (url.endsWith('/ack-batch') || url.endsWith('/move-to-wait')) {
        return Promise.resolve(json({ ok: true }));
      }
      return Promise.resolve(json({ ok: true }));
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
    await settle(15);
    hook.unmount();
    pull.resolve(json({ ok: true, jobs: [{ id: 'foreign-job' }], tokens: ['lock-foreign'] }));
    await run;

    expect(pulls).toBe(1);
    expect(calls.some((url) => url.endsWith('/ack-batch'))).toBe(false);
    expect(calls.filter((url) => url.endsWith('/move-to-wait'))).toHaveLength(1);
  });
});
