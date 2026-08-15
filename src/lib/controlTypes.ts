export type ServerRunStatus = 'running' | 'stopped' | 'starting' | 'stopping';
export type ServerManagementMode = 'managed' | 'external';

export interface ServerConfig {
  command: string;
  httpPort: number;
  tcpPort: number;
  dataPath: string;
  extraEnv: Record<string, string>;
}

/** On-disk footprint of the SQLite database (main file + WAL + SHM sidecars). */
export interface DbStats {
  path: string;
  exists: boolean;
  size: number;
  walSize: number;
  shmSize: number;
  totalSize: number;
  mtimeMs: number | null;
}

export interface ServerStatus {
  /** Lifecycle owner. Missing means managed for compatibility with older agents. */
  managementMode?: ServerManagementMode;
  status: ServerRunStatus;
  generation: number;
  pid: number | null;
  startedAt: number | null;
  exitCode: number | null;
  healthy: boolean;
  version?: string;
  /** External-mode reachability and the agent-side health target/result. */
  reachable?: boolean;
  externalUrl?: string;
  healthStatus?: number | null;
  healthError?: string;
  config: ServerConfig;
  /** Config the live process was launched with (null when stopped). */
  runningConfig?: ServerConfig | null;
  /** SQLite on-disk size for the configured data path. */
  db?: DbStats | null;
}

export interface ServerLogLine {
  seq: number;
  ts: number;
  stream: 'stdout' | 'stderr' | 'sys';
  line: string;
}
