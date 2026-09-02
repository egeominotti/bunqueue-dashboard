import type { ServerConfig } from './types';

export type ManagedStorageMode = 'memory' | 'sqlite' | 'postgres';

/** Mirrors Bunqueue 2.9's explicit-driver, PostgreSQL-URL, then data-path precedence. */
export function managedStorageMode(config: ServerConfig): ManagedStorageMode {
  const explicit = config.extraEnv.BUNQUEUE_STORAGE_DRIVER ?? process.env.BUNQUEUE_STORAGE_DRIVER;
  if (explicit === 'postgres' || explicit === 'memory' || explicit === 'sqlite') return explicit;
  if (explicit) throw new Error(`Unsupported storage driver: ${explicit}`);
  const postgresUrl = config.extraEnv.BUNQUEUE_POSTGRES_URL ?? process.env.BUNQUEUE_POSTGRES_URL;
  if (postgresUrl) return 'postgres';
  return config.dataPath ? 'sqlite' : 'memory';
}

export function managedPostgresUrl(config: ServerConfig): string | undefined {
  return (config.extraEnv.BUNQUEUE_POSTGRES_URL ?? process.env.BUNQUEUE_POSTGRES_URL)?.trim() || undefined;
}

export function managedPostgresNamespace(config: ServerConfig): string {
  return (
    (config.extraEnv.BUNQUEUE_POSTGRES_NAMESPACE ?? process.env.BUNQUEUE_POSTGRES_NAMESPACE)?.trim() ||
    'default'
  );
}

/** Credential-free PostgreSQL cluster label safe to expose to authenticated operators. */
export function managedPostgresTarget(config: ServerConfig): string | undefined {
  const configured = managedPostgresUrl(config);
  if (!configured) return undefined;
  try {
    const parsed = new URL(configured);
    if (
      (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') ||
      !parsed.hostname
    ) {
      return undefined;
    }
    const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, '')) || 'postgres';
    return `${parsed.hostname}:${parsed.port || '5432'}/${database}`;
  } catch {
    return undefined;
  }
}

/** Fail before spawning when Bunqueue would reject an incomplete PostgreSQL config. */
export function validateManagedStorage(config: ServerConfig): ManagedStorageMode {
  const mode = managedStorageMode(config);
  if (mode === 'postgres' && !managedPostgresUrl(config)) {
    throw new Error('PostgreSQL storage requires BUNQUEUE_POSTGRES_URL');
  }
  return mode;
}

/** Non-SQLite drivers cannot be combined with Bunqueue's legacy SQLite path aliases. */
export function removeSqlitePaths(env: Record<string, string>): void {
  delete env.BUNQUEUE_DATA_PATH;
  delete env.BQ_DATA_PATH;
  delete env.DATA_PATH;
  delete env.SQLITE_PATH;
}
