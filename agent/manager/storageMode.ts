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

/** Non-SQLite drivers cannot be combined with Bunqueue's legacy SQLite path aliases. */
export function removeSqlitePaths(env: Record<string, string>): void {
  delete env.BUNQUEUE_DATA_PATH;
  delete env.BQ_DATA_PATH;
  delete env.DATA_PATH;
  delete env.SQLITE_PATH;
}
