import { afterEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { BackupRepository } from '../src/features/backups/application/BackupRepository';
import { createBackupRunnerCoordinator } from '../src/features/backups/application/backupRunnerCoordinator';
import { BackupOperationsPanel } from '../src/features/backups/ui/BackupOperationsPanel';
import type { DbStats } from '../src/lib/bqTypes';
import { ensureDom } from './domSetup';

ensureDom();
const mounted = new Set<() => void>();

afterEach(() => {
  for (const unmount of mounted) unmount();
  mounted.clear();
});

describe('S3 backup runner coordination', () => {
  test('releases the FIFO after rejected and aborted entries', async () => {
    const coordinator = createBackupRunnerCoordinator();
    const calls: string[] = [];
    await expect(
      coordinator.run(async () => {
        calls.push('rejected');
        throw new Error('expected failure');
      })
    ).rejects.toThrow('expected failure');

    const controller = new AbortController();
    controller.abort(new Error('scope closed'));
    await expect(
      coordinator.run(async () => {
        calls.push('must-not-run');
      }, controller.signal)
    ).rejects.toThrow('scope closed');

    await coordinator.run(async () => {
      calls.push('recovered');
    });
    expect(calls).toEqual(['rejected', 'recovered']);
  });

  test('admits reads and mutations in FIFO order without overlap', async () => {
    const coordinator = createBackupRunnerCoordinator();
    const readGate = deferred();
    const backupGate = deferred();
    const calls: string[] = [];

    const read = coordinator.run(async () => {
      calls.push('status:start');
      await readGate.promise;
      calls.push('status:end');
    });
    await tick();
    const backup = coordinator.run(async () => {
      calls.push('backup:start');
      await backupGate.promise;
      calls.push('backup:end');
    });
    const poll = coordinator.run(async () => {
      calls.push('poll:start');
      calls.push('poll:end');
    });

    await tick();
    expect(calls).toEqual(['status:start']);
    readGate.resolve();
    await waitFor(() => calls.includes('backup:start'));
    expect(calls).toEqual(['status:start', 'status:end', 'backup:start']);
    backupGate.resolve();
    await Promise.all([read, backup, poll]);
    expect(calls).toEqual([
      'status:start',
      'status:end',
      'backup:start',
      'backup:end',
      'poll:start',
      'poll:end',
    ]);
  });

  test('blocks refresh and automatic polling for the full backup and restore windows', async () => {
    const backupGate = deferred();
    const restoreGate = deferred();
    const calls: string[] = [];
    let active = '';
    let conflicts = 0;
    const guarded = async <T,>(name: string, value: T, gate?: Promise<void>): Promise<T> => {
      if (active) {
        conflicts += 1;
        throw new Error(`Another backup operation is already running: ${active}/${name}`);
      }
      active = name;
      calls.push(`${name}:start`);
      try {
        if (gate) await gate;
        else await tick();
        return value;
      } finally {
        calls.push(`${name}:end`);
        active = '';
      }
    };
    const repository: BackupRepository = {
      status: () =>
        guarded('status', {
          success: true,
          message: 'configured',
          data: {
            enabled: true,
            bucket: 'production',
            endpoint: 'AWS S3',
            interval: '360 minutes',
            retention: '7 backups',
          },
        }),
      list: () =>
        guarded('list', {
          success: true,
          message: 'one backup',
          data: [{ key: 'backups/one.db', size: '1 MB', date: '2026-08-15T12:00:00.000Z' }],
        }),
      backupNow: () =>
        guarded('backup', { success: true, message: 'Backup created' }, backupGate.promise),
      restore: () =>
        guarded('restore', { success: true, message: 'Restore complete' }, restoreGate.promise),
      configure: async () => ({ configured: true, enabled: true }),
      restoreContext: async () => ({ serverStatus: 'stopped', database }),
    };
    const originalConfirm = window.confirm;
    const originalPrompt = window.prompt;
    window.confirm = () => true;
    window.prompt = () => 'RESTORE';

    try {
      const host = render(createElement(BackupOperationsPanel, { pollIntervalMs: 5, repository }));
      await waitFor(() => host.textContent?.includes('backups/one.db') === true);

      click(button(host, 'Backup now'));
      await waitFor(() => active === 'backup');
      const readsAtBackupStart = readCount(calls);
      const backupRefresh = button(host, 'Refresh');
      expect(backupRefresh.disabled).toBe(true);
      click(backupRefresh);
      await sleepInAct(25);
      expect(readCount(calls)).toBe(readsAtBackupStart);
      expect(conflicts).toBe(0);

      backupGate.resolve();
      await waitFor(() =>
        Array.from(host.querySelectorAll('button')).some(
          (item) => item.textContent?.includes('Backup now') && !item.disabled
        )
      );
      click(button(host, 'Restore'));
      await waitFor(() => active === 'restore');
      const readsAtRestoreStart = readCount(calls);
      const restoreRefresh = button(host, 'Refresh');
      expect(restoreRefresh.disabled).toBe(true);
      click(restoreRefresh);
      await sleepInAct(25);
      expect(readCount(calls)).toBe(readsAtRestoreStart);
      expect(conflicts).toBe(0);
      expect(host.querySelector('[role="alert"]')?.textContent ?? '').not.toContain(
        'Another backup operation'
      );

      restoreGate.resolve();
      await waitFor(() => host.textContent?.includes('Restore complete') === true);
      await waitFor(() => button(host, 'Backup now').disabled === false);
      expect(conflicts).toBe(0);
    } finally {
      window.confirm = originalConfirm;
      window.prompt = originalPrompt;
    }
  });
});

const database: DbStats = {
  path: '/tmp/bunqueue.db',
  exists: true,
  size: 100,
  walSize: 20,
  shmSize: 10,
  totalSize: 130,
  mtimeMs: 1234,
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function render(element: ReactElement): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.add(() => act(() => root.unmount()));
  act(() => root.render(element));
  return host;
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

function readCount(calls: string[]): number {
  return calls.filter((call) => call === 'status:start' || call === 'list:start').length;
}

async function tick(): Promise<void> {
  await Promise.resolve();
}

async function sleepInAct(milliseconds: number): Promise<void> {
  await act(async () => {
    await Bun.sleep(milliseconds);
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_500): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error('Timed out waiting for UI state');
    await sleepInAct(5);
  }
}
