import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import {
  createDbDetailSelection,
  Database,
  dbDetailMatchesPage,
} from '../src/pages/control/Database';
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

function _deferred<T>() {
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

function _findButton(host: ParentNode, text: string): HTMLButtonElement {
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
