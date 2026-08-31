import type { BackupItem, BackupStatus } from '../application/BackupRepository';

const STATUS_KEYS = new Set(['enabled', 'bucket', 'endpoint', 'interval', 'retention']);
const ITEM_KEYS = new Set(['key', 'size', 'date']);

export function parseBackupStatus(value: unknown): BackupStatus {
  const status = exactRecord(value, STATUS_KEYS, 'Backup status');
  if (typeof status.enabled !== 'boolean') invalid('Backup status');
  return {
    enabled: status.enabled,
    bucket: text(status.bucket, 'Backup status bucket', 1_024),
    endpoint: text(status.endpoint, 'Backup status endpoint', 4_096),
    interval: text(status.interval, 'Backup status interval', 128),
    retention: text(status.retention, 'Backup status retention', 128),
  };
}

export function parseBackupList(value: unknown): BackupItem[] {
  if (!Array.isArray(value) || value.length > 20_000) invalid('Backup list');
  const keys = new Set<string>();
  let textSize = 0;
  return value.map((entry, index) => {
    const item = exactRecord(entry, ITEM_KEYS, `Backup list item ${index}`);
    const key = text(item.key, `Backup list item ${index} key`, 2_048);
    const size = text(item.size, `Backup list item ${index} size`, 128);
    const date = text(item.date, `Backup list item ${index} date`, 128);
    textSize += key.length + size.length + date.length;
    if (textSize > 2 * 1024 * 1024 || keys.has(key) || !validIsoDate(date)) {
      invalid(`Backup list item ${index}`);
    }
    keys.add(key);
    return { key, size, date };
  });
}

function exactRecord(
  value: unknown,
  allowed: ReadonlySet<string>,
  label: string
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(label);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.has(key))) invalid(label);
  return record;
}

function text(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength) invalid(label);
  return value;
}

function validIsoDate(value: string): boolean {
  const timestamp = Date.parse(value);
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString() === value
  );
}

function invalid(label: string): never {
  throw new Error(`${label} returned an invalid Bunqueue 2.9.2 contract`);
}
