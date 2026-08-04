/** Public compatibility entrypoint for managed bunqueue process supervision. */
export { validateConfigPatch } from './manager/config';
export { ProcessManager } from './manager/process';
export type {
  DbStats,
  LogLine,
  ServerConfig,
  Status,
  StatusSnapshot,
} from './manager/types';
