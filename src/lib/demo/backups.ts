import type { Json } from './shared';

const success = (result: unknown): Json => ({ ok: true, result });

export function demoBackupResponse(segments: string[], method: string): Json {
  const operation = segments[1];
  if (method === 'GET' && operation === 'status') {
    return success({
      success: true,
      message: 'Backup configuration loaded',
      data: {
        enabled: true,
        bucket: 'bunqueue-demo-backups',
        endpoint: 'https://s3.example.com',
        interval: '6h',
        retention: '30d',
      },
    });
  }
  if (method === 'GET' && operation === 'list') {
    return success({
      success: true,
      message: 'Backups listed',
      data: [
        { key: 'backups/bunqueue-2026-08-04.db', size: '2.6 MB', date: '2026-08-04T10:00:00Z' },
        { key: 'backups/bunqueue-2026-08-03.db', size: '2.5 MB', date: '2026-08-03T10:00:00Z' },
      ],
    });
  }
  if (method === 'POST' && operation === 'configure') {
    return success({ configured: true, enabled: true });
  }
  if (method === 'POST' && operation === 'now') {
    return success({
      success: true,
      message: 'Demo backup completed',
      data: { key: 'backups/bunqueue-demo-now.db' },
    });
  }
  if (method === 'POST' && operation === 'restore') {
    return success({ success: true, message: 'Demo backup restored' });
  }
  return { ok: false, error: 'Demo backup route not found' };
}
