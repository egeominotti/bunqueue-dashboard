import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import {
  buildS3Environment,
  parseStorageHealthResponse,
  S3BackupPro,
} from '../src/pages/control/S3BackupPro';
import { downloadProcessLogs } from '../src/pages/control/server/ProcessLogs';
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
