import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, createRef, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { Benchmark } from '../src/pages/control/Benchmark';
import { DEFAULT_CONFIG } from '../src/pages/control/benchmark/engine';
import { useBenchmark } from '../src/pages/control/benchmark/useBenchmark';
import {
  collectTableExport,
  createDbDetailSelection,
  Database,
  dbDetailMatchesPage,
  parseDbQueryResponse,
  parseDbRowsResponse,
  QueryRunner,
  RowDetailDrawer,
  sanitizeQueryHistory,
} from '../src/pages/control/Database';
import {
  buildS3Environment,
  parseStorageHealthResponse,
  S3BackupPro,
} from '../src/pages/control/S3BackupPro';
import { downloadProcessLogs } from '../src/pages/control/server/ProcessLogs';
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

function click(element: Element): void {
  act(() => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
}

function dbPage(table: string, offset: number, rows: unknown[][], total: number) {
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

function dbExportResponse(
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
          json({ ok: true, jobs: pulls === 1 ? [{ id: 'benchmark-own' }] : [] })
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
        return Promise.resolve(json({ ok: true, jobs: [{ id: 'benchmark-own' }] }));
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
    expect(hook.result.current.phase).toBe('stopped');
    hook.unmount();
  });

  test('unmount while pull is pending prevents ACK, retry, and another pull', async () => {
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
    pull.resolve(json({ ok: true, jobs: [{ id: 'foreign-job' }] }));
    await run;

    expect(pulls).toBe(1);
    expect(calls.some((url) => url.endsWith('/ack-batch'))).toBe(false);
    expect(calls.some((url) => url.endsWith('/move-to-wait'))).toBe(false);
  });
});

describe('Database export, query, history, and drawer isolation', () => {
  test('uses one agent-side snapshot request pinned to table and credential', async () => {
    const first = deferred<Response>();
    const requests: Array<{ url: string; auth: string | null }> = [];
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, auth: new Headers(init?.headers).get('authorization') });
      return first.promise;
    }) as typeof fetch;

    const requested = { table: 'table-a', dir: 'asc' as const };
    const exportedPromise = collectTableExport(requested);
    requested.table = 'table-b';
    act(() => {
      useConnectionStore.setState({ agentToken: 'agent-bravo' });
    });
    first.resolve(dbExportResponse('table-a', 'id\r\n1\r\n2', 2));
    const exported = await exportedPromise;

    expect(exported.rowCount).toBe(2);
    expect(new TextDecoder().decode(exported.content)).toBe('id\r\n1\r\n2');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain('/db/tables/table-a/export?dir=asc');
    expect(requests[0]?.auth).toBe('Bearer agent-alpha');
  });

  test('rejects a mismatched export identity before exposing bytes', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(dbExportResponse('table-b', 'id\r\n1', 1))) as typeof fetch;
    await expect(collectTableExport({ table: 'table-a', dir: 'asc' })).rejects.toThrow(
      'requested "table-a", received "table-b"'
    );
  });

  test('rejects export metadata above the hard row/byte contract', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(dbExportResponse('table-a', 'id\r\n1', 200_001, 'rows'))) as typeof fetch;
    await expect(collectTableExport({ table: 'table-a', dir: 'asc' })).rejects.toThrow(
      'invalid X-Bunqueue-Db-Export-Rows header'
    );

    globalThis.fetch = (() =>
      Promise.resolve(
        dbExportResponse('table-a', 'id\r\n1', 1, 'none', {
          'X-Bunqueue-Db-Export-Bytes': String(16 * 1024 * 1024 + 1),
        })
      )) as typeof fetch;
    await expect(collectTableExport({ table: 'table-a', dir: 'asc' })).rejects.toThrow(
      'invalid X-Bunqueue-Db-Export-Bytes header'
    );
  });

  test('rows parser rejects malformed data and every identity mismatch', () => {
    const expected = {
      table: 'jobs',
      limit: 50,
      offset: 50,
      orderBy: 'id',
      dir: 'desc' as const,
      filter: { column: 'state', op: 'eq' as const, value: 'failed' },
    };
    const valid = {
      ...dbPage('jobs', 50, [[51]], 51),
      orderBy: 'id',
      dir: 'desc' as const,
      filter: expected.filter,
    };
    expect(parseDbRowsResponse(valid, expected).rows).toEqual([[51]]);
    for (const mismatch of [
      { table: 'other' },
      { limit: 49 },
      { offset: 0 },
      { orderBy: null },
      { dir: 'asc' },
      { filter: null },
    ]) {
      expect(() => parseDbRowsResponse({ ...valid, ...mismatch }, expected)).toThrow(
        'identity mismatch'
      );
    }
    expect(() => parseDbRowsResponse({ ...valid, rows: [[51, 'extra']] }, expected)).toThrow(
      'Malformed database rows response'
    );
    expect(() => parseDbRowsResponse({ ...valid, truncatedCells: [] }, expected)).toThrow(
      'Malformed database rows response'
    );
  });

  test('query result parser rejects malformed 2xx envelopes before render', () => {
    expect(() => parseDbQueryResponse({})).toThrow('Malformed database query response');
    expect(() =>
      parseDbQueryResponse({
        ok: true,
        columns: ['id'],
        rows: [[1, 2]],
        rowCount: 1,
        truncated: false,
        ms: 1,
      })
    ).toThrow('Malformed database query response');
    expect(
      parseDbQueryResponse({
        ok: true,
        columns: ['id'],
        rows: [[1]],
        rowCount: 1,
        truncated: false,
        ms: 1.5,
      })
    ).toEqual({ columns: ['id'], rows: [[1]], rowCount: 1, truncated: false, ms: 1.5 });
  });

  test('connection change invalidates an in-flight query from the old target', async () => {
    const oldQuery = deferred<Response>();
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.endsWith('/db/query')) {
        return Promise.resolve(json({ ok: false, error: `unexpected ${url}` }, 500));
      }
      const auth = new Headers(init?.headers).get('authorization');
      if (auth === 'Bearer agent-alpha') return oldQuery.promise;
      return Promise.resolve(
        json({ ok: true, columns: ['server'], rows: [['B']], rowCount: 1, truncated: false, ms: 2 })
      );
    }) as typeof fetch;

    const editorRef = createRef<HTMLTextAreaElement>();
    const view = render(
      createElement(QueryRunner, {
        sql: 'SELECT server',
        setSql: () => undefined,
        editorRef,
      })
    );
    click(findButton(view.host, 'Run'));
    await settle(5);
    act(() => useConnectionStore.setState({ agentToken: 'agent-bravo' }));
    await settle(5);
    click(findButton(view.host, 'Run'));
    await settle(10);
    expect(view.host.textContent).toContain('B');

    oldQuery.resolve(
      json({ ok: true, columns: ['server'], rows: [['A']], rowCount: 1, truncated: false, ms: 99 })
    );
    await settle(10);
    expect(view.host.textContent).toContain('B');
    expect(view.host.textContent).not.toContain('99 ms');
    expect(view.host.textContent).not.toContain('>A<');
  });

  test('bounds and deduplicates hostile persisted query history', () => {
    const hostile = [
      'SELECT 1',
      'SELECT 1',
      'x'.repeat(20_001),
      42,
      ...Array.from({ length: 30 }, (_, index) => `SELECT ${index + 2}`),
    ];
    const clean = sanitizeQueryHistory(hostile);
    expect(clean).toHaveLength(10);
    expect(clean[0]).toBe('SELECT 1');
    expect(new Set(clean).size).toBe(clean.length);
    expect(clean.every((entry) => entry.length <= 20_000)).toBe(true);
  });

  test('drawer reports full-cell failures, traps focus, and restores the invoker', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(json({ ok: false, error: 'cell read failed' }, 500))) as typeof fetch;
    const invoker = document.createElement('button');
    invoker.textContent = 'outside';
    document.body.appendChild(invoker);
    invoker.focus();

    const view = render(
      createElement(RowDetailDrawer, {
        table: 'jobs',
        columns: ['payload'],
        row: ['preview'],
        rowid: 1,
        truncated: [true],
        onClose: () => undefined,
      })
    );
    await settle(10);
    const dialog = view.host.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog).not.toBeNull();
    expect(view.host.textContent).toContain('full value unavailable — cell read failed');
    expect(dialog.contains(document.activeElement)).toBe(true);

    invoker.focus();
    expect(dialog.contains(document.activeElement)).toBe(true);
    const close = view.host.querySelector('[aria-label="Close"]') as HTMLButtonElement;
    close.focus();
    act(() =>
      close.dispatchEvent(
        new window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true })
      )
    );
    expect(dialog.contains(document.activeElement)).toBe(true);

    view.unmount();
    expect(document.activeElement).toBe(invoker);
    invoker.remove();
  });

  test('database grid fails closed with accessible errors on mismatched and malformed payloads', async () => {
    let rowsPayload: unknown = dbPage('other-table', 0, [['DO-NOT-RENDER']], 1);
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://test.invalid');
      if (url.pathname === '/db/tables') {
        return Promise.resolve(json({ ok: true, tables: [{ name: 'jobs', rows: 1, columns: 1 }] }));
      }
      if (url.pathname === '/db/info') {
        return Promise.resolve(
          json({
            ok: true,
            sqliteVersion: '3',
            pageSize: 4096,
            pageCount: 1,
            journalMode: 'wal',
            freelistPages: 0,
            tables: 1,
            indexes: 0,
            fileSize: 1,
            walSize: 0,
          })
        );
      }
      if (url.pathname.endsWith('/schema')) {
        return Promise.resolve(
          json({
            ok: true,
            table: 'jobs',
            columns: [
              { name: 'id', type: 'TEXT', notNull: true, defaultValue: null, primaryKey: true },
            ],
            indexes: [],
            sql: null,
            rowCount: 1,
          })
        );
      }
      if (url.pathname === '/db/tables/jobs') {
        return Promise.resolve(json(rowsPayload));
      }
      return Promise.resolve(json({ ok: false, error: `unexpected ${url.pathname}` }, 500));
    }) as typeof fetch;

    const view = render(createElement(Database));
    await settle(30);
    const alert = view.host.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain('identity mismatch');
    expect(view.host.textContent).not.toContain('DO-NOT-RENDER');
    expect(view.host.querySelector('tbody tr')).toBeNull();
    view.unmount();

    rowsPayload = { ...dbPage('jobs', 0, [['MALFORMED', 'EXTRA']], 1) };
    const malformedView = render(createElement(Database));
    await settle(30);
    const malformedAlert = malformedView.host.querySelector('[role="alert"]');
    expect(malformedAlert?.textContent).toContain('Malformed database rows response');
    expect(malformedView.host.textContent).not.toContain('MALFORMED');
    expect(malformedView.host.querySelector('tbody tr')).toBeNull();
  });

  test('opening a row makes the database background inert and aria-hidden', async () => {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://test.invalid');
      if (url.pathname === '/db/tables') {
        return Promise.resolve(json({ ok: true, tables: [{ name: 'jobs', rows: 1, columns: 1 }] }));
      }
      if (url.pathname === '/db/info') {
        return Promise.resolve(
          json({
            ok: true,
            sqliteVersion: '3',
            pageSize: 4096,
            pageCount: 1,
            journalMode: 'wal',
            freelistPages: 0,
            tables: 1,
            indexes: 0,
            fileSize: 1,
            walSize: 0,
          })
        );
      }
      if (url.pathname.endsWith('/schema')) {
        return Promise.resolve(
          json({
            ok: true,
            table: 'jobs',
            columns: [
              { name: 'id', type: 'INTEGER', notNull: true, defaultValue: null, primaryKey: true },
            ],
            indexes: [],
            sql: null,
            rowCount: 1,
          })
        );
      }
      if (url.pathname === '/db/tables/jobs') {
        return Promise.resolve(json(dbPage('jobs', 0, [[1]], 1)));
      }
      return Promise.resolve(json({ ok: false, error: `unexpected ${url.pathname}` }, 500));
    }) as typeof fetch;

    const view = render(createElement(Database));
    await settle(30);
    const row = view.host.querySelector('tbody tr') as HTMLTableRowElement | null;
    expect(row).not.toBeNull();
    expect(row?.tabIndex).toBe(-1);
    expect(row?.getAttribute('role')).toBeNull();
    const viewAction = view.host.querySelector(
      '[aria-label="View row 1 details"]'
    ) as HTMLButtonElement | null;
    expect(viewAction).not.toBeNull();
    if (viewAction) click(viewAction);
    await settle(5);

    const background = view.host.querySelector('[data-database-background]') as HTMLElement;
    expect(background.hasAttribute('inert')).toBe(true);
    expect(background.getAttribute('aria-hidden')).toBe('true');
    const dialog = document.body.querySelector('[role="dialog"]') as HTMLElement | null;
    expect(dialog).not.toBeNull();
    expect(dialog?.classList.contains('focus-visible:outline-2')).toBe(true);
    expect(dialog?.querySelector('.overscroll-contain')).not.toBeNull();

    click(document.body.querySelector('[aria-label="Close"]') as Element);
    expect(background.hasAttribute('inert')).toBe(false);
    expect(background.hasAttribute('aria-hidden')).toBe(false);
  });

  test('a poll cannot replace the open drawer with another row at the same index', async () => {
    let replacement = false;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://test.invalid');
      if (url.pathname === '/db/tables') {
        return Promise.resolve(json({ ok: true, tables: [{ name: 'jobs', rows: 1, columns: 1 }] }));
      }
      if (url.pathname === '/db/info') {
        return Promise.resolve(
          json({
            ok: true,
            sqliteVersion: '3',
            pageSize: 4096,
            pageCount: 1,
            journalMode: 'wal',
            freelistPages: 0,
            tables: 1,
            indexes: 0,
            fileSize: 1,
            walSize: 0,
          })
        );
      }
      if (url.pathname.endsWith('/schema')) {
        return Promise.resolve(
          json({
            ok: true,
            table: 'jobs',
            columns: [
              { name: 'id', type: 'TEXT', notNull: true, defaultValue: null, primaryKey: true },
            ],
            indexes: [],
            sql: null,
            rowCount: 1,
          })
        );
      }
      if (url.pathname === '/db/tables/jobs') {
        return Promise.resolve(
          json({
            ...dbPage('jobs', 0, [[replacement ? 'replacement' : 'original']], 1),
            rowids: [replacement ? 22 : 11],
          })
        );
      }
      return Promise.resolve(json({ ok: false, error: `unexpected ${url.pathname}` }, 500));
    }) as typeof fetch;

    const view = render(createElement(Database));
    await settle(30);
    click(view.host.querySelector('[aria-label="View row 1 details"]') as Element);
    await settle(5);
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain('original');

    replacement = true;
    // Visibility restoration drives the same scheduler as the 6s poll, without
    // making this regression sleep for a full interval.
    act(() => document.dispatchEvent(new window.Event('visibilitychange')));
    await settle(30);

    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(view.host.textContent).toContain('replacement');
    expect(
      (view.host.querySelector('[data-database-background]') as HTMLElement).hasAttribute('inert')
    ).toBe(false);
  });

  test('WITHOUT ROWID drawer identity falls back to an immutable row fingerprint', () => {
    const first = { ...dbPage('items', 0, [['same']], 1), rowids: [null] };
    const selection = createDbDetailSelection(first, 0);
    expect(selection).not.toBeNull();
    if (!selection) return;
    expect(dbDetailMatchesPage(selection, first)).toBe(true);
    expect(
      dbDetailMatchesPage(selection, {
        ...dbPage('items', 0, [['replacement']], 1),
        rowids: [null],
      })
    ).toBe(false);
  });
});

describe('S3 storage checks and process-log downloads', () => {
  test('generates only the real v2.8.55 server environment and validates unsafe drafts', () => {
    const built = buildS3Environment({
      endpoint: 'https://r2.example.test',
      region: 'auto',
      bucket: 'production',
      accessKeyId: 'access',
      secretAccessKey: 'secret',
      sessionToken: 'temporary-token',
      schedule: '6h',
      pathPrefix: 'backups/production/',
      virtualHostedStyle: 'path-style',
      retention: 14,
    });
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.value).toContain('S3_BACKUP_ENABLED=true');
      expect(built.value).toContain('S3_BACKUP_INTERVAL=21600000');
      expect(built.value).toContain('S3_SECRET_ACCESS_KEY="secret"');
      expect(built.value).toContain('S3_SESSION_TOKEN="temporary-token"');
      expect(built.value).toContain('S3_VIRTUAL_HOSTED_STYLE=false');
      expect(built.value).toContain('S3_BACKUP_RETENTION=14');
    }
    expect(
      buildS3Environment({
        endpoint: 'https://user:password@example.test',
        region: '',
        bucket: '',
        accessKeyId: '',
        secretAccessKey: '',
        sessionToken: '',
        schedule: 'disabled',
        pathPrefix: '',
        virtualHostedStyle: 'auto',
        retention: 7,
      })
    ).toEqual({ ok: true, value: 'S3_BACKUP_ENABLED=false' });
  });

  test('requires the exact nested disk-health response shape', () => {
    expect(() => parseStorageHealthResponse({ ok: true, data: {} })).toThrow(
      'missing disk health data'
    );
    expect(() => parseStorageHealthResponse({ ok: 'yes', data: { diskFull: false } })).toThrow(
      'Malformed storage status response'
    );
    expect(parseStorageHealthResponse({ ok: false, data: { diskFull: true } })).toEqual({
      diskFull: true,
    });
  });

  test('a late storage result from target A cannot overwrite target B', async () => {
    const oldCheck = deferred<Response>();
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get('authorization');
      if (auth === 'Bearer alpha') return oldCheck.promise;
      return Promise.resolve(json({ ok: true, data: { diskFull: false } }));
    }) as typeof fetch;

    const view = render(createElement(S3BackupPro));
    click(findButton(view.host, 'Check server storage'));
    await settle(5);
    act(() => useConnectionStore.setState({ baseUrl: 'http://server-b.test', token: 'bravo' }));
    await settle(5);
    click(findButton(view.host, 'Check server storage'));
    await settle(10);
    expect(view.host.textContent).toContain('Server disk healthy');

    oldCheck.resolve(json({ ok: false, data: { diskFull: true } }));
    await settle(10);
    expect(view.host.textContent).toContain('Server disk healthy');
    expect(view.host.textContent).not.toContain('Server disk is full');
  });

  test('ProcessLogs attaches its anchor and revokes the URL on a later task', async () => {
    const urlApi = globalThis.URL as unknown as {
      createObjectURL: (blob: Blob) => string;
      revokeObjectURL: (url: string) => void;
    };
    const previousCreate = urlApi.createObjectURL;
    const previousRevoke = urlApi.revokeObjectURL;
    const revoked: string[] = [];
    urlApi.createObjectURL = () => 'blob:process-logs';
    urlApi.revokeObjectURL = (url) => revoked.push(url);
    const anchorProto = (document.createElement('a') as HTMLAnchorElement)
      .constructor as unknown as {
      prototype: { click: () => void };
    };
    const previousClick = anchorProto.prototype.click;
    let attached = false;
    anchorProto.prototype.click = function patched(this: HTMLAnchorElement) {
      attached = this.isConnected;
      expect(this.download).toBe('bunqueue-logs-123.log');
    };
    try {
      downloadProcessLogs('line one', 123);
      expect(attached).toBe(true);
      expect(revoked).toEqual([]);
      expect(document.querySelector('a[download="bunqueue-logs-123.log"]')).toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(revoked).toEqual(['blob:process-logs']);
    } finally {
      anchorProto.prototype.click = previousClick;
      urlApi.createObjectURL = previousCreate;
      urlApi.revokeObjectURL = previousRevoke;
    }
  });
});
