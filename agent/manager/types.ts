export type Status = 'running' | 'stopped' | 'starting' | 'stopping';

export interface ServerConfig {
  /** Command to launch the server. */
  command: string;
  httpPort: number;
  tcpPort: number;
  dataPath: string;
  extraEnv: Record<string, string>;
}

export interface LogLine {
  seq: number;
  ts: number;
  stream: 'stdout' | 'stderr' | 'sys';
  line: string;
}

export interface DbStats {
  path: string;
  exists: boolean;
  size: number;
  walSize: number;
  shmSize: number;
  totalSize: number;
  mtimeMs: number | null;
}

export interface StatusSnapshot {
  status: Status;
  /** Monotonic identity of the managed process generation. */
  generation: number;
  /** Monotonic desired-config revision used for optimistic updates. */
  configRevision?: number;
  pid: number | null;
  startedAt: number | null;
  exitCode: number | null;
  config: ServerConfig;
  runningConfig: ServerConfig | null;
}
