import { afterEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { BackupRepository } from '../src/features/backups/application/BackupRepository';
import { parseGeneratedEnvironment } from '../src/features/backups/domain/environmentRecord';
import { BackupOperationsPanel } from '../src/features/backups/ui/BackupOperationsPanel';
import type { DbStats } from '../src/lib/bqTypes';
import { ensureDom, settle } from './domSetup';

ensureDom();
const mounted = new Set<() => void>();

afterEach(() => {
  for (const unmount of mounted) unmount();
  mounted.clear();
});

describe('S3 backup operations', () => {
  test('parses only generated S3 environment records', () => {
    expect(
      parseGeneratedEnvironment(
        'S3_BACKUP_ENABLED=true\nS3_BUCKET="production"\nS3_BACKUP_RETENTION=7'
      )
    ).toEqual({
      S3_BACKUP_ENABLED: 'true',
      S3_BUCKET: 'production',
      S3_BACKUP_RETENTION: '7',
    });
    expect(() => parseGeneratedEnvironment('PATH="/tmp"')).toThrow('Unexpected backup key');
  });

  test('applies config, creates a backup and restores only with explicit confirmation', async () => {
    const calls: unknown[] = [];
    const repository = fakeRepository({
      configure: async (environment) => {
        calls.push(['configure', environment]);
        return { configured: true, enabled: true };
      },
      backupNow: async () => {
        calls.push(['backup']);
        return { success: true, message: 'Backup created' };
      },
      restore: async (key, database) => {
        calls.push(['restore', key, database]);
        return { success: true, message: 'Restore complete' };
      },
    });
    const originalConfirm = window.confirm;
    const originalPrompt = window.prompt;
    window.confirm = () => true;
    window.prompt = () => 'RESTORE';
    try {
      const host = render(
        createElement(BackupOperationsPanel, {
          repository,
          environmentText: 'S3_BACKUP_ENABLED=true\nS3_BUCKET="production"',
        })
      );
      await settle(3);
      click(button(host, 'Apply configuration'));
      await settle(3);
      click(button(host, 'Backup now'));
      await settle(3);
      click(button(host, 'Restore'));
      await settle(3);
      expect(calls).toEqual([
        ['configure', { S3_BACKUP_ENABLED: 'true', S3_BUCKET: 'production' }],
        ['backup'],
        ['restore', 'backups/one.db', database],
      ]);
    } finally {
      window.confirm = originalConfirm;
      window.prompt = originalPrompt;
    }
  });

  test('turns malformed Bunqueue status and list data into a recoverable panel error', async () => {
    const repository = fakeRepository({
      status: async () => ({
        success: true,
        message: 'bad status',
        data: { enabled: 'yes' } as never,
      }),
      list: async () => ({
        success: true,
        message: 'bad list',
        data: 'not-an-array' as never,
      }),
    });
    const host = render(createElement(BackupOperationsPanel, { repository }));
    await settle(3);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'invalid Bunqueue 2.8.59 contract'
    );
    expect(host.textContent).toContain('No backup objects returned');
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

function fakeRepository(overrides: Partial<BackupRepository>): BackupRepository {
  return {
    status: async () => ({
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
    list: async () => ({
      success: true,
      message: 'one backup',
      data: [{ key: 'backups/one.db', size: '1.00 MB', date: '2026-08-04T10:00:00.000Z' }],
    }),
    backupNow: async () => ({ success: true, message: 'ok' }),
    restore: async () => ({ success: true, message: 'ok' }),
    configure: async () => ({ configured: true, enabled: true }),
    restoreContext: async () => ({ serverStatus: 'stopped', database }),
    ...overrides,
  };
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
