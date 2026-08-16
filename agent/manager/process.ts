import { copyConfig, defaultConfig, validateConfigPatch, validateServerConfig } from './config';
import { ProcessLogs } from './logs';
import { databaseStats } from './storage';
import type {
  DbStats,
  LogLine,
  ServerConfig,
  Status,
  StatusSnapshot,
} from './types';

const STOP_TIMEOUT_MS = 8000;
type ManagedProcess = ReturnType<typeof Bun.spawn>;

async function exitsWithin(process: ManagedProcess, timeout: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    process.exited.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeout);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Supervises one bunqueue server child process. */
export class ProcessManager {
  private proc: ManagedProcess | null = null;
  private status: Status = 'stopped';
  private startedAt: number | null = null;
  private exitCode: number | null = null;
  private config: ServerConfig = defaultConfig();
  // A per-agent random seed prevents stale compare-and-set tokens from a
  // previous control-agent process matching again after a restart (ABA).
  private configRevision = configRevisionSeed();
  private runningConfig: ServerConfig | null = null;
  private procToken = 0;
  private stopping: Promise<StatusSnapshot> | null = null;
  private shuttingDown = false;
  private maintenance: string | null = null;
  private output = new ProcessLogs();

  constructor(private readonly stopTimeoutMs = STOP_TIMEOUT_MS) {}

  getConfig(): ServerConfig {
    return copyConfig(this.config);
  }

  getConfigRevision(): number {
    return this.configRevision;
  }

  setConfig(patch: Partial<ServerConfig>, expectedRevision?: number): ServerConfig {
    if (expectedRevision !== undefined && expectedRevision !== this.configRevision) {
      throw new Error(
        `Configuration changed since revision ${expectedRevision}; current revision is ${this.configRevision}`
      );
    }
    const valid = validateConfigPatch(patch);
    const next = validateServerConfig({
      ...this.config,
      ...valid,
      extraEnv: valid.extraEnv ?? this.config.extraEnv,
    });
    if (!sameConfig(this.config, next)) {
      this.config = next;
      this.configRevision = nextConfigRevision(this.configRevision);
    }
    return copyConfig(this.config);
  }

  getStatus(): StatusSnapshot {
    return {
      status: this.status,
      generation: this.procToken,
      configRevision: this.configRevision,
      pid: this.proc?.pid ?? null,
      startedAt: this.startedAt,
      exitCode: this.exitCode,
      config: copyConfig(this.config),
      runningConfig: this.runningConfig ? copyConfig(this.runningConfig) : null,
    };
  }

  dbStats(dataPath?: string): Promise<DbStats> {
    const effectivePath =
      dataPath ?? (this.runningConfig ?? this.config).dataPath;
    return databaseStats(effectivePath);
  }

  getLogs(): LogLine[] {
    return this.output.get();
  }

  async start(): Promise<StatusSnapshot> {
    this.assertNoMaintenance('start');
    if (this.shuttingDown) return this.getStatus();
    if (this.status === 'running' || this.status === 'starting') return this.getStatus();
    if (this.stopping) await this.stopping;
    this.assertNoMaintenance('start');
    if (this.shuttingDown) return this.getStatus();
    const statusAfterWait = this.status as Status;
    if (statusAfterWait === 'running' || statusAfterWait === 'starting') {
      return this.getStatus();
    }
    if (this.proc) {
      throw new Error(
        `Cannot start while the previous managed process (pid ${this.proc.pid}) is still alive`
      );
    }

    const launchConfig = validateServerConfig(this.config);
    const [command, ...args] = launchConfig.command.trim().split(/\s+/);
    this.status = 'starting';
    this.exitCode = null;
    const token = ++this.procToken;
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...launchConfig.extraEnv,
      HTTP_PORT: String(launchConfig.httpPort),
      TCP_PORT: String(launchConfig.tcpPort),
      BUNQUEUE_DATA_PATH: launchConfig.dataPath,
    };

    try {
      this.proc = Bun.spawn([command, ...args], {
        env,
        stdout: 'pipe',
        stderr: 'pipe',
        onExit: (_process, code) => {
          this.output.cancel(token);
          if (this.procToken !== token) return;
          this.exitCode = code ?? null;
          this.status = 'stopped';
          this.proc = null;
          this.runningConfig = null;
          this.output.push('sys', `process exited (code ${code ?? '?'})`);
        },
      });
    } catch (error) {
      this.status = 'stopped';
      this.proc = null;
      this.runningConfig = null;
      throw new Error(`Failed to spawn "${command}": ${(error as Error).message}`);
    }

    this.startedAt = Date.now();
    this.status = 'running';
    this.runningConfig = copyConfig(launchConfig);
    this.output.push('sys', `started: ${launchConfig.command} (pid ${this.proc.pid})`);
    const isCurrent = () => this.procToken === token;
    void this.output.capture(
      this.proc.stdout as unknown as ReadableStream<Uint8Array>,
      'stdout',
      token,
      isCurrent
    );
    void this.output.capture(
      this.proc.stderr as unknown as ReadableStream<Uint8Array>,
      'stderr',
      token,
      isCurrent
    );
    return this.getStatus();
  }

  stop(): Promise<StatusSnapshot> {
    if (this.stopping) return this.stopping;
    const pending = this.stopOnce();
    this.stopping = pending;
    const clearStopping = () => {
      if (this.stopping === pending) this.stopping = null;
    };
    void pending.then(clearStopping, clearStopping);
    return pending;
  }

  /** Permanently prevent this manager from spawning another child process. */
  beginShutdown(): void {
    this.shuttingDown = true;
  }

  /** Last-resort terminal path used after graceful shutdown times out. */
  forceShutdown(): void {
    this.beginShutdown();
    if (!this.proc) return;
    this.output.push('sys', `force stopping pid ${this.proc.pid} (SIGKILL)`);
    this.proc.kill(9);
  }

  async shutdown(): Promise<StatusSnapshot> {
    this.beginShutdown();
    return this.stop();
  }

  private async stopOnce(): Promise<StatusSnapshot> {
    if (!this.proc) {
      this.status = 'stopped';
      this.runningConfig = null;
      return this.getStatus();
    }
    this.status = 'stopping';
    this.output.push('sys', 'stopping (SIGTERM)…');
    const process = this.proc;
    const token = this.procToken;
    process.kill();
    if (!(await exitsWithin(process, this.stopTimeoutMs))) {
      this.output.push('sys', 'SIGTERM timed out, sending SIGKILL');
      process.kill(9);
      if (!(await exitsWithin(process, this.stopTimeoutMs))) {
        const message = `pid ${process.pid} did not exit after SIGKILL`;
        this.output.push('sys', `${message} — retaining failed-process tracking`);
        throw new Error(message);
      }
    }
    this.output.cancel(token);
    if (this.procToken !== token) return this.getStatus();
    this.status = 'stopped';
    this.proc = null;
    this.runningConfig = null;
    return this.getStatus();
  }

  async restart(): Promise<StatusSnapshot> {
    this.assertNoMaintenance('restart');
    await this.stop();
    return this.start();
  }

  /** Hold an atomic stopped-server lease across a destructive maintenance task. */
  async withStoppedMaintenance<T>(label: string, operation: () => Promise<T>): Promise<T> {
    if (this.maintenance) {
      throw new Error(`Another maintenance operation is already running: ${this.maintenance}`);
    }
    if (this.proc || this.status !== 'stopped' || this.stopping) {
      throw new Error(`Stop the managed Bunqueue server before ${label}`);
    }
    this.maintenance = label;
    try {
      return await operation();
    } finally {
      if (this.maintenance === label) this.maintenance = null;
    }
  }

  private assertNoMaintenance(action: 'start' | 'restart'): void {
    if (this.maintenance) {
      throw new Error(
        `Cannot ${action} the managed Bunqueue server while ${this.maintenance} is running`
      );
    }
  }
}

function sameConfig(left: ServerConfig, right: ServerConfig): boolean {
  const leftEnv = Object.entries(left.extraEnv).sort(([a], [b]) => a.localeCompare(b));
  const rightEnv = Object.entries(right.extraEnv).sort(([a], [b]) => a.localeCompare(b));
  return (
    left.command === right.command &&
    left.httpPort === right.httpPort &&
    left.tcpPort === right.tcpPort &&
    left.dataPath === right.dataPath &&
    JSON.stringify(leftEnv) === JSON.stringify(rightEnv)
  );
}

function configRevisionSeed(): number {
  const words = crypto.getRandomValues(new Uint32Array(2));
  return ((words[0] ?? 0) & 0x1f_ffff) * 0x1_0000_0000 + (words[1] ?? 0);
}

function nextConfigRevision(current: number): number {
  if (current < Number.MAX_SAFE_INTEGER) return current + 1;
  let next = configRevisionSeed();
  while (next === current) next = configRevisionSeed();
  return next;
}
