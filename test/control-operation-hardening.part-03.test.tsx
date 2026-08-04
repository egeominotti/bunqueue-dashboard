import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import {
  collectTableExport,
  parseDbQueryResponse,
  parseDbRowsResponse,
} from '../src/pages/control/Database';
import { ensureDom } from './domSetup';

ensureDom();

const realFetch = globalThis.fetch;
const realConfirm = globalThis.window.confirm;
const mounted = new Set<() => void>();

const _json = (value: unknown, status = 200) =>
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
});
