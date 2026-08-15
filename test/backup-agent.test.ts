import { describe, expect, test } from 'bun:test';
import { routeBackupRequest } from '../agent/backup/routes';
import {
  type BackupOperation,
  type BackupRunnerPort,
  BunqueueBackupRunner,
} from '../agent/backup/runner';
import type { DbStats, ServerConfig } from '../agent/manager';

const config: ServerConfig = {
  command: 'bunqueue',
  httpPort: 6790,
  tcpPort: 6789,
  dataPath: '/tmp/dashboard-backup.db',
  extraEnv: {
    S3_BACKUP_ENABLED: 'true',
    S3_ACCESS_KEY_ID: 'test-access',
    S3_SECRET_ACCESS_KEY: 'test-secret',
    S3_BUCKET: 'test-bucket',
    S3_REGION: 'us-east-1',
  },
};
const database: DbStats = {
  path: config.dataPath,
  exists: true,
  size: 100,
  walSize: 20,
  shmSize: 10,
  totalSize: 130,
  mtimeMs: 1234,
};

describe('Bunqueue S3 backup agent', () => {
  test('rejects malformed status and list data at the executor boundary', async () => {
    const malformed = [
      ['status', { enabled: 'true' }],
      ['list', [{ key: 'backup.db', size: '1 MB', date: 'not-a-date' }]],
    ] as const;
    for (const [operation, data] of malformed) {
      const runner = new BunqueueBackupRunner(1_000, async () => ({
        success: true,
        message: 'malformed fixture',
        data,
      }));
      await expect(runner.execute(config, operation)).rejects.toThrow('invalid 2.8.59 contract');
      await runner.close();
    }
  });

  test('normalizes the exact 2.8.59 backup list contract', async () => {
    const data = [{ key: 'backups/one.db', size: '1.00 MB', date: '2026-08-04T10:00:00.000Z' }];
    const runner = new BunqueueBackupRunner(1_000, async () => ({
      success: true,
      message: 'Found 1 backup(s)',
      data,
    }));
    expect((await runner.execute(config, 'list')).data).toEqual(data);
    await runner.close();
  });

  test('executes the official 2.8.59 CLI status contract locally', async () => {
    const result = await new BunqueueBackupRunner().execute(config, 'status');
    expect(result.success).toBeTrue();
    expect(result.data).toEqual({
      enabled: true,
      bucket: 'test-bucket',
      endpoint: 'AWS S3',
      interval: '360 minutes',
      retention: '7 backups',
    });
  });

  test('wires status, list and manual backup through an exact managed target', async () => {
    const calls: string[] = [];
    const runner = fakeRunner(calls);
    await route('/backup/status', 'GET', true, runner);
    await route('/backup/list', 'GET', true, runner);
    await route('/backup/now', 'POST', true, runner);
    expect(calls).toEqual(['status', 'list', 'now']);
    await expect(
      route('/backup/status', 'GET', true, runner, undefined, 'https://remote.test')
    ).rejects.toThrow('does not match the agent-managed Bunqueue server');
  });

  test('allows restore only while stopped and against the confirmed database snapshot', async () => {
    const calls: string[] = [];
    const runner = fakeRunner(calls);
    await expect(
      route('/backup/restore', 'POST', true, runner, { key: 'backups/a.db', database })
    ).rejects.toThrow('Stop the managed Bunqueue server');
    await expect(
      route('/backup/restore', 'POST', false, runner, {
        key: 'backups/a.db',
        database: { ...database, walSize: 21 },
      })
    ).rejects.toThrow('Database changed after restore confirmation');
    await route('/backup/restore', 'POST', false, runner, {
      key: 'backups/a.db',
      database,
    });
    expect(calls).toEqual(['restore:backups/a.db']);
  });

  test('atomically replaces only the managed S3 environment keys', async () => {
    let configured: Record<string, string> | undefined;
    const runner = fakeRunner([]);
    await route(
      '/backup/configure',
      'POST',
      true,
      runner,
      {
        environment: {
          S3_BACKUP_ENABLED: 'false',
        },
      },
      '/api',
      (next) => {
        configured = next;
      }
    );
    expect(configured).toEqual({ S3_BACKUP_ENABLED: 'false' });
    await expect(
      route(
        '/backup/configure',
        'POST',
        true,
        runner,
        { environment: { S3_BACKUP_ENABLED: 'true', PATH: '/tmp/evil' } },
        '/api',
        () => undefined
      )
    ).rejects.toThrow('Unknown backup environment key');
    await expect(
      route(
        '/backup/configure',
        'POST',
        true,
        runner,
        {
          environment: { S3_BACKUP_ENABLED: 'false' },
          extra: true,
        },
        '/api',
        () => undefined
      )
    ).rejects.toThrow('Unknown backup body option');
    await expect(
      route(
        '/backup/configure',
        'POST',
        true,
        runner,
        {
          environment: { S3_BACKUP_ENABLED: 'false' },
          padding: 'x'.repeat(64 * 1024),
        },
        '/api',
        () => undefined
      )
    ).rejects.toThrow('Backup request exceeds 64 KiB');
  });
});

function route(
  path: string,
  method: string,
  running: boolean,
  runner: BackupRunnerPort,
  body?: unknown,
  target = '/api',
  configure?: (extraEnv: Record<string, string>) => void
) {
  const request = new Request(`http://agent${path}?target=${encodeURIComponent(target)}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
  });
  return routeBackupRequest(request, path, method, config, running, database, runner, configure);
}

function fakeRunner(calls: string[]): BackupRunnerPort {
  return {
    execute: async (_config, operation: BackupOperation, key?: string) => {
      calls.push(`${operation}${key ? `:${key}` : ''}`);
      return { success: true, message: 'ok', data: [] };
    },
    close: async () => undefined,
  };
}
