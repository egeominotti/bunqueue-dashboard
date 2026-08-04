import type { BackupCommandResult, BackupOperation } from './runner';

const RESULT_KEYS = new Set(['success', 'message', 'data']);
const STATUS_KEYS = new Set(['enabled', 'bucket', 'endpoint', 'interval', 'retention']);
const ITEM_KEYS = new Set(['key', 'size', 'date']);
const MAX_MESSAGE_LENGTH = 16 * 1024;
const MAX_LIST_ITEMS = 20_000;
const MAX_LIST_TEXT = 2 * 1024 * 1024;

export function validateBackupResult(
  value: unknown,
  operation: BackupOperation
): BackupCommandResult {
  const result = exactRecord(value, RESULT_KEYS, 'backup command result');
  if (typeof result.success !== 'boolean') invalid('backup command result success');
  const message = text(result.message, 'backup command result message', MAX_MESSAGE_LENGTH);
  if (!result.success) throw new Error(message);
  const data = operationData(operation, result.data);
  return data === undefined ? { success: true, message } : { success: true, message, data };
}

function operationData(operation: BackupOperation, value: unknown): unknown {
  if (operation === 'status') return statusData(value);
  if (operation === 'list') return listData(value);
  return value;
}

function statusData(value: unknown): Record<string, string | boolean> {
  const status = exactRecord(value, STATUS_KEYS, 'backup status data');
  if (typeof status.enabled !== 'boolean') invalid('backup status enabled');
  return {
    enabled: status.enabled,
    bucket: text(status.bucket, 'backup status bucket', 1_024),
    endpoint: text(status.endpoint, 'backup status endpoint', 4_096),
    interval: text(status.interval, 'backup status interval', 128),
    retention: text(status.retention, 'backup status retention', 128),
  };
}

function listData(value: unknown): Array<Record<string, string>> {
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) invalid('backup list data');
  let textSize = 0;
  const keys = new Set<string>();
  return value.map((entry, index) => {
    const item = exactRecord(entry, ITEM_KEYS, `backup list item ${index}`);
    const key = text(item.key, `backup list item ${index} key`, 2_048);
    const size = text(item.size, `backup list item ${index} size`, 128);
    const date = text(item.date, `backup list item ${index} date`, 128);
    textSize += key.length + size.length + date.length;
    if (textSize > MAX_LIST_TEXT || keys.has(key) || !validIsoDate(date)) {
      invalid(`backup list item ${index}`);
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
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !allowed.has(key))) invalid(label);
  return result;
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
  throw new Error(`Bunqueue ${label} has an invalid 2.8.57 contract`);
}
