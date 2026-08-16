import { assertManagedTarget, type ManagedTargetPolicy } from '../managedTarget';
import type { DbStats, ServerConfig } from '../manager';
import { readLimitedJsonBody } from '../server/jsonBody';
import type { BackupRunnerPort } from './runner';

const MAX_BACKUP_BODY_BYTES = 64 * 1024;

export interface BackupRouteResponse {
  status: number;
  body: Record<string, unknown>;
}

export type PreparedBackupRequest =
  | { operation: 'status' | 'list' | 'now'; query: URLSearchParams }
  | { operation: 'configure'; query: URLSearchParams; environment: unknown }
  | { operation: 'restore'; query: URLSearchParams; key: string; database: unknown };

/** Read and validate the bounded HTTP payload before acquiring a lifecycle lease. */
export async function prepareBackupRequest(
  request: Request,
  pathname: string,
  method: string,
  config?: ServerConfig,
  targetPolicy?: ManagedTargetPolicy
): Promise<PreparedBackupRequest | null> {
  const operation = routeOperation(pathname, method);
  if (!operation) return null;
  const query = exactTargetQuery(request.url);
  if (config) assertManagedTarget(query, config, targetPolicy);
  if (operation === 'configure') {
    const body = await boundedRecord(request, ['environment']);
    return { operation, query, environment: body.environment };
  }
  if (operation === 'restore') {
    const body = await boundedRecord(request, ['key', 'database']);
    return { operation, query, key: backupKey(body.key), database: body.database };
  }
  return { operation, query };
}

/** Execute a prepared operation against one lifecycle-pinned config/database snapshot. */
export async function executePreparedBackupRequest(
  prepared: PreparedBackupRequest,
  config: ServerConfig,
  serverRunning: boolean,
  database: DbStats,
  runner: BackupRunnerPort,
  configure?: (extraEnv: Record<string, string>) => void | Promise<void>,
  targetPolicy?: ManagedTargetPolicy
): Promise<BackupRouteResponse> {
  assertManagedTarget(prepared.query, config, targetPolicy);
  if (prepared.operation === 'configure') {
    if (!configure) throw new Error('Backup configuration is unavailable');
    const next = mergeBackupEnvironment(config.extraEnv, prepared.environment);
    await configure(next);
    return success({ configured: true, enabled: next.S3_BACKUP_ENABLED === 'true' });
  }
  if (prepared.operation === 'restore') {
    if (serverRunning) throw new Error('Stop the managed Bunqueue server before restoring a backup');
    assertDatabaseSnapshot(prepared.database, database);
    return success(await runner.execute(config, prepared.operation, prepared.key));
  }
  return success(await runner.execute(config, prepared.operation));
}

export async function routeBackupRequest(
  request: Request,
  pathname: string,
  method: string,
  config: ServerConfig,
  serverRunning: boolean,
  database: DbStats,
  runner: BackupRunnerPort,
  configure?: (extraEnv: Record<string, string>) => void,
  targetPolicy?: ManagedTargetPolicy
): Promise<BackupRouteResponse | null> {
  const prepared = await prepareBackupRequest(request, pathname, method, config, targetPolicy);
  return prepared
    ? executePreparedBackupRequest(
        prepared,
        config,
        serverRunning,
        database,
        runner,
        configure,
        targetPolicy
      )
    : null;
}

function routeOperation(pathname: string, method: string) {
  if (method === 'GET' && pathname === '/backup/status') return 'status' as const;
  if (method === 'GET' && pathname === '/backup/list') return 'list' as const;
  if (method === 'POST' && pathname === '/backup/now') return 'now' as const;
  if (method === 'POST' && pathname === '/backup/restore') return 'restore' as const;
  if (method === 'POST' && pathname === '/backup/configure') return 'configure' as const;
  return null;
}

const BACKUP_ENV_KEYS = new Set([
  'S3_BACKUP_ENABLED',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'S3_SESSION_TOKEN',
  'S3_BUCKET',
  'S3_ENDPOINT',
  'S3_VIRTUAL_HOSTED_STYLE',
  'S3_REGION',
  'S3_BACKUP_INTERVAL',
  'S3_BACKUP_RETENTION',
  'S3_BACKUP_PREFIX',
]);

function mergeBackupEnvironment(
  current: Record<string, string>,
  value: unknown
): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Backup environment must be an object');
  }
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [key, entry] of entries) {
    if (!BACKUP_ENV_KEYS.has(key)) throw new Error(`Unknown backup environment key: ${key}`);
    if (typeof entry !== 'string' || entry.length > 4_096) {
      throw new Error(`Backup environment ${key} must be a string of at most 4096 characters`);
    }
  }
  const enabled = (value as Record<string, unknown>).S3_BACKUP_ENABLED;
  if (enabled !== 'true' && enabled !== 'false') {
    throw new Error('S3_BACKUP_ENABLED must be "true" or "false"');
  }
  const retained = Object.fromEntries(
    Object.entries(current).filter(([key]) => !BACKUP_ENV_KEYS.has(key))
  );
  return { ...retained, ...(Object.fromEntries(entries) as Record<string, string>) };
}

function exactTargetQuery(url: string): URLSearchParams {
  const query = new URL(url).searchParams;
  for (const key of query.keys()) {
    if (key !== 'target') throw new Error(`Unknown backup option: ${key}`);
    if (query.getAll(key).length !== 1) throw new Error(`Duplicate backup option: ${key}`);
  }
  return query;
}

function success(result: unknown): BackupRouteResponse {
  return { status: 200, body: { ok: true, result } };
}

function record(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Backup restore body must be an object');
  }
  const body = value as Record<string, unknown>;
  const unknown = Object.keys(body).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`Unknown backup body option: ${unknown}`);
  return body;
}

async function boundedRecord(
  request: Request,
  allowed: string[]
): Promise<Record<string, unknown>> {
  const value = await readLimitedJsonBody(request, {
    scope: 'Backup',
    maxBytes: MAX_BACKUP_BODY_BYTES,
    limitLabel: '64 KiB',
    missingMessage: 'Backup request body must be valid JSON',
    invalidUtf8Message: 'Backup request body must be valid JSON',
    invalidJsonMessage: 'Backup request body must be valid JSON',
  });
  return record(value, allowed);
}

function backupKey(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 2_048 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error('Backup key must contain 1–2048 printable characters');
  }
  return value;
}

function assertDatabaseSnapshot(value: unknown, current: DbStats): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('A database snapshot is required to authorize restore');
  }
  const expected = value as Record<string, unknown>;
  const allowed = ['path', 'exists', 'size', 'walSize', 'shmSize', 'totalSize', 'mtimeMs'];
  const unknown = Object.keys(expected).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`Unknown database snapshot option: ${unknown}`);
  if (
    expected.path !== current.path ||
    expected.exists !== current.exists ||
    expected.size !== current.size ||
    expected.walSize !== current.walSize ||
    expected.shmSize !== current.shmSize ||
    expected.totalSize !== current.totalSize ||
    expected.mtimeMs !== current.mtimeMs
  ) {
    throw new Error('Database changed after restore confirmation; reload status and confirm again');
  }
}
