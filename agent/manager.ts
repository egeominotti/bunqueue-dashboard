/**
 * ProcessManager — supervises a bunqueue server child process so the dashboard
 * can start / stop / restart it. Runs under Bun (uses Bun.spawn).
 *
 * It does NOT import or touch bunqueue source — it just launches a configurable
 * command (default `bunqueue start`) with the ports/data-path passed as env.
 */

export type Status = 'running' | 'stopped' | 'starting' | 'stopping';

export interface ServerConfig {
  /** Command to launch the server, e.g. "bunqueue start" or "bun run src/main.ts". */
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

/** On-disk footprint of the configured SQLite database (main + WAL + SHM). */
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
  pid: number | null;
  startedAt: number | null;
  exitCode: number | null;
  /** Editable/desired config — takes effect on the next start/restart. */
  config: ServerConfig;
  /** Config the live process was actually launched with (null when stopped). */
  runningConfig: ServerConfig | null;
}

const MAX_LOGS = 800;
const STOP_TIMEOUT_MS = 8000;

function defaultConfig(): ServerConfig {
  return {
    command: process.env.BUNQUEUE_START_CMD || 'bunqueue start',
    httpPort: Number(process.env.HTTP_PORT) || 6790,
    tcpPort: Number(process.env.TCP_PORT) || 6789,
    dataPath: process.env.BUNQUEUE_DATA_PATH || './data/bunq.db',
    extraEnv: {},
  };
}

export class ProcessManager {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private status: Status = 'stopped';
  private startedAt: number | null = null;
  private exitCode: number | null = null;
  private config: ServerConfig = defaultConfig();
  private runningConfig: ServerConfig | null = null;
  private logs: LogLine[] = [];
  private seq = 0;
  /**
   * Monotonic id for the current process generation. Every start() bumps it;
   * onExit and stop() only mutate shared state when their captured token is
   * still current, so a stop() awaiting an old process can't clobber a process
   * a concurrent start() brought up (and vice-versa).
   */
  private procToken = 0;

  getConfig(): ServerConfig {
    return this.config;
  }

  /**
   * Update the desired config. Editing while the server runs is allowed; the
   * change applies on the next start/restart (the live process keeps using
   * `runningConfig` until then). Ports/data-path of a live process cannot be
   * changed in place.
   */
  setConfig(patch: Partial<ServerConfig>): ServerConfig {
    this.config = { ...this.config, ...patch, extraEnv: patch.extraEnv ?? this.config.extraEnv };
    return this.config;
  }

  getStatus(): StatusSnapshot {
    return {
      status: this.status,
      pid: this.proc?.pid ?? null,
      startedAt: this.startedAt,
      exitCode: this.exitCode,
      config: this.config,
      runningConfig: this.runningConfig,
    };
  }

  /** Stat the configured SQLite db file plus its WAL/SHM sidecars. */
  async dbStats(): Promise<DbStats> {
    const path = this.config.dataPath;
    const one = async (p: string): Promise<{ size: number; mtimeMs: number | null }> => {
      try {
        const f = Bun.file(p);
        if (!(await f.exists())) return { size: 0, mtimeMs: null };
        return { size: f.size, mtimeMs: f.lastModified };
      } catch {
        return { size: 0, mtimeMs: null };
      }
    };
    const [main, wal, shm] = await Promise.all([
      one(path),
      one(`${path}-wal`),
      one(`${path}-shm`),
    ]);
    return {
      path,
      exists: main.mtimeMs !== null,
      size: main.size,
      walSize: wal.size,
      shmSize: shm.size,
      totalSize: main.size + wal.size + shm.size,
      mtimeMs: main.mtimeMs,
    };
  }

  getLogs(): LogLine[] {
    return this.logs;
  }

  private push(stream: LogLine['stream'], line: string): void {
    this.logs.push({ seq: this.seq++, ts: Date.now(), stream, line });
    if (this.logs.length > MAX_LOGS) this.logs.splice(0, this.logs.length - MAX_LOGS);
  }

  async start(): Promise<StatusSnapshot> {
    if (this.status === 'running' || this.status === 'starting') return this.getStatus();
    this.status = 'starting';
    this.exitCode = null;
    const token = ++this.procToken;

    const parts = this.config.command.trim().split(/\s+/);
    const [cmd, ...args] = parts;
    if (!cmd) {
      this.status = 'stopped';
      throw new Error('Empty command');
    }

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      HTTP_PORT: String(this.config.httpPort),
      TCP_PORT: String(this.config.tcpPort),
      BUNQUEUE_DATA_PATH: this.config.dataPath,
      ...this.config.extraEnv,
    };

    try {
      this.proc = Bun.spawn([cmd, ...args], {
        env,
        stdout: 'pipe',
        stderr: 'pipe',
        onExit: (_p, code) => {
          // Ignore the exit of a process a newer start() has already replaced.
          if (this.procToken !== token) return;
          this.exitCode = code ?? null;
          this.status = 'stopped';
          this.proc = null;
          this.runningConfig = null;
          this.push('sys', `process exited (code ${code ?? '?'})`);
        },
      });
    } catch (e) {
      this.status = 'stopped';
      throw new Error(`Failed to spawn "${cmd}": ${(e as Error).message}`);
    }

    this.startedAt = Date.now();
    this.status = 'running';
    this.runningConfig = { ...this.config, extraEnv: { ...this.config.extraEnv } };
    this.push('sys', `started: ${this.config.command} (pid ${this.proc.pid})`);
    void this.pipe(this.proc.stdout as ReadableStream<Uint8Array>, 'stdout');
    void this.pipe(this.proc.stderr as ReadableStream<Uint8Array>, 'stderr');
    return this.getStatus();
  }

  private async pipe(stream: ReadableStream<Uint8Array>, name: 'stdout' | 'stderr'): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let i: number;
        while ((i = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, i);
          buffer = buffer.slice(i + 1);
          if (line.trim()) this.push(name, line);
        }
      }
    } catch {
      /* stream closed */
    }
  }

  async stop(): Promise<StatusSnapshot> {
    if (!this.proc) {
      this.status = 'stopped';
      this.runningConfig = null;
      return this.getStatus();
    }
    this.status = 'stopping';
    this.push('sys', 'stopping (SIGTERM)…');
    const proc = this.proc;
    const token = this.procToken;
    proc.kill();
    const timedOut = await Promise.race([
      proc.exited.then(() => false),
      new Promise<boolean>((r) => setTimeout(() => r(true), STOP_TIMEOUT_MS)),
    ]);
    // Always escalate to SIGKILL on the CAPTURED proc (never `this.proc`) so a
    // child that ignores SIGTERM is still reaped even if a concurrent start()
    // has since swapped in a new process — `proc` targets this generation only.
    if (timedOut) {
      this.push('sys', 'SIGTERM timed out, sending SIGKILL');
      proc.kill(9);
      await proc.exited;
    }
    // Only finalize shared state if no newer start() replaced this generation
    // while we awaited — otherwise we'd null out the wrong (live) process.
    if (this.procToken !== token) return this.getStatus();
    this.status = 'stopped';
    this.proc = null;
    this.runningConfig = null;
    return this.getStatus();
  }

  async restart(): Promise<StatusSnapshot> {
    await this.stop();
    return this.start();
  }
}
