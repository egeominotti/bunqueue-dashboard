/** Public compatibility entrypoint for managed bunqueue process supervision. */
export { validateConfigPatch } from './manager/config';
export { ProcessManager } from './manager/process';
export { managedPostgresNamespace, managedStorageMode } from './manager/storageMode';
export type {
  DbStats,
  LogLine,
  ServerConfig,
  Status,
  StatusSnapshot,
} from './manager/types';
