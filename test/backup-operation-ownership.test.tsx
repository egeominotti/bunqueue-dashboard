import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { BackupOperationsPanel } from '../src/features/backups/ui/BackupOperationsPanel';
import { ensureDom } from './domSetup';

ensureDom();
const mounted = new Set<() => void>();
const originalFetch = globalThis.fetch;
const originalConfirm = window.confirm;
const originalPrompt = window.prompt;

interface FetchRecord {
  authorization: string | null;
  body: string;
  method: string;
  url: URL;
}

beforeEach(() => {
  useConnectionStore.setState({
    baseUrl: 'https://server-a.invalid/api',
    token: 'server-a-token',
    agentToken: 'agent-a-token',
    refreshMs: 3000,
  });
  window.confirm = () => true;
  window.prompt = () => 'RESTORE';
});

afterEach(() => {
  for (const unmount of mounted) unmount();
  mounted.clear();
  globalThis.fetch = originalFetch;
  window.confirm = originalConfirm;
  window.prompt = originalPrompt;
  useConnectionStore.setState({ baseUrl: '/api', token: '', agentToken: '', refreshMs: 3000 });
});

describe('S3 operation target ownership', () => {
  test('drops a queued restore on A→B and keeps every snapshot request target-auth coherent', async () => {
    const transport = installBackupTransport();
    const view = render(createElement(BackupOperationsPanel, { pollIntervalMs: 60_000 }));
    await waitFor(() => view.host.textContent?.includes('backups/server-a.db') === true);

    const heldStatus = deferred<Response>();
    transport.holdNextStatus(heldStatus.promise);
    click(button(view.host, 'Refresh'));
    await waitFor(() => transport.statusCalls() === 2);
    click(button(view.host, 'Restore'));
    expect(button(view.host, 'Backup now').disabled).toBe(true);

    act(() => {
      useConnectionStore.setState({
        baseUrl: 'https://server-b.invalid/api',
        token: 'server-b-token',
        agentToken: 'agent-b-token',
      });
    });
    heldStatus.resolve(statusResponse());
    await waitFor(() => transport.targets().includes('https://server-b.invalid/api'));

    expect(transport.records.some((record) => record.url.pathname === '/backup/restore')).toBe(
      false
    );
    expect(
      transport.records.filter(
        (record) =>
          record.url.pathname === '/backup/list' &&
          record.url.searchParams.get('target') === 'https://server-a.invalid/api'
      ).length
    ).toBeGreaterThanOrEqual(2);
    for (const record of transport.records.filter(
      (item) => item.url.searchParams.get('target') === 'https://server-a.invalid/api'
    )) {
      expect(record.authorization).toBe('Bearer agent-a-token');
    }
    for (const record of transport.records.filter(
      (item) => item.url.searchParams.get('target') === 'https://server-b.invalid/api'
    )) {
      expect(record.authorization).toBe('Bearer agent-b-token');
    }
  });

  test('never runs a queued configuration mutation after unmount', async () => {
    const transport = installBackupTransport();
    const view = render(
      createElement(BackupOperationsPanel, {
        environmentText: 'S3_BACKUP_ENABLED=true\nS3_BUCKET="production"',
        pollIntervalMs: 60_000,
      })
    );
    await waitFor(() => view.host.textContent?.includes('backups/server-a.db') === true);

    const heldStatus = deferred<Response>();
    transport.holdNextStatus(heldStatus.promise);
    click(button(view.host, 'Refresh'));
    await waitFor(() => transport.statusCalls() === 2);
    click(button(view.host, 'Apply configuration'));
    expect(button(view.host, 'Backup now').disabled).toBe(true);

    view.unmount();
    heldStatus.resolve(statusResponse());
    await Bun.sleep(25);
    expect(transport.records.some((record) => record.url.pathname === '/backup/configure')).toBe(
      false
    );
  });
});

function installBackupTransport(): {
  holdNextStatus: (response: Promise<Response>) => void;
  records: FetchRecord[];
  statusCalls: () => number;
  targets: () => string[];
} {
  const records: FetchRecord[] = [];
  let heldStatus: Promise<Response> | null = null;
  let statusCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : {}));
    records.push({
      authorization: headers.get('Authorization'),
      body: typeof init?.body === 'string' ? init.body : '',
      method: init?.method ?? (input instanceof Request ? input.method : 'GET'),
      url,
    });
    if (url.pathname === '/backup/status') {
      statusCalls += 1;
      if (heldStatus) {
        const response = heldStatus;
        heldStatus = null;
        return response;
      }
      return statusResponse();
    }
    if (url.pathname === '/backup/list') return listResponse(url.searchParams.get('target'));
    if (url.pathname === '/control/status') {
      return json({ status: 'stopped', db: database });
    }
    if (url.pathname.startsWith('/backup/')) {
      return json({ ok: true, result: { success: true, message: 'unexpected mutation' } });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  return {
    holdNextStatus: (response) => {
      heldStatus = response;
    },
    records,
    statusCalls: () => statusCalls,
    targets: () =>
      records
        .map((record) => record.url.searchParams.get('target'))
        .filter((target): target is string => target !== null),
  };
}

const database = {
  path: '/server-a/db.sqlite',
  exists: true,
  size: 100,
  walSize: 20,
  shmSize: 10,
  totalSize: 130,
  mtimeMs: 1234,
};

function statusResponse(): Response {
  return json({
    ok: true,
    result: {
      success: true,
      message: 'configured',
      data: {
        enabled: true,
        bucket: 'production',
        endpoint: 'AWS S3',
        interval: '360 minutes',
        retention: '7 backups',
      },
    },
  });
}

function listResponse(target: string | null): Response {
  const owner = target?.includes('server-b') ? 'server-b' : 'server-a';
  return json({
    ok: true,
    result: {
      success: true,
      message: 'one backup',
      data: [
        {
          key: `backups/${owner}.db`,
          size: '1.00 MB',
          date: '2026-08-15T12:00:00.000Z',
        },
      ],
    },
  });
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function render(element: ReactElement): { host: HTMLElement; unmount: () => void } {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let active = true;
  const unmount = () => {
    if (!active) return;
    active = false;
    mounted.delete(unmount);
    act(() => root.unmount());
    host.remove();
  };
  mounted.add(unmount);
  act(() => root.render(element));
  return { host, unmount };
}

function button(host: ParentNode, label: string): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll('button')).find((item) =>
    item.textContent?.includes(label)
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

function click(element: HTMLButtonElement): void {
  act(() => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_500): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error('Timed out waiting for backup UI state');
    await act(async () => {
      await Bun.sleep(5);
    });
  }
}
