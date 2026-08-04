import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, createRef, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { QueryRunner, RowDetailDrawer, sanitizeQueryHistory } from '../src/pages/control/Database';
import { ensureDom, settle } from './domSetup';

ensureDom();

const realFetch = globalThis.fetch;
const realConfirm = globalThis.window.confirm;
const mounted = new Set<() => void>();

const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'content-type': 'application/json' } });

const _benchmarkCounts = (over: Record<string, number> = {}) => ({
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

describe('Database export, query, history, and drawer isolation', () => {
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
});
