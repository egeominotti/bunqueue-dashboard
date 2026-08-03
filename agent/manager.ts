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
/**
 * Hard byte cap for a single log line. The ring buffer trims by COUNT, so a
 * child that dumps a large blob without a newline (binary file, one-line JSON)
 * would otherwise grow the reader's in-flight buffer — and then one retained
 * LogLine — without limit.
 */
const MAX_LINE = 8192;

interface CancelablePipeReader {
  cancel(reason?: unknown): Promise<void>;
}

function defaultConfig(): ServerConfig {
  return {
    command: process.env.BUNQUEUE_START_CMD || 'bunqueue start',
    httpPort: Number(process.env.HTTP_PORT) || 6790,
    tcpPort: Number(process.env.TCP_PORT) || 6789,
    dataPath: process.env.BUNQUEUE_DATA_PATH || './data/bunq.db',
    extraEnv: {},
  };
}

const CONFIG_KEYS = new Set<keyof ServerConfig>([
  'command',
  'httpPort',
  'tcpPort',
  'dataPath',
  'extraEnv',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function validatePort(name: 'httpPort' | 'tcpPort', value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return value;
}

/**
 * Validate an untrusted PUT /control/config body before any field is merged.
 * Returning a fresh object (including a fresh extraEnv) makes setConfig atomic:
 * one invalid field cannot leave earlier fields applied, and the caller cannot
 * mutate the accepted config later through a retained object reference.
 */
export function validateConfigPatch(value: unknown): Partial<ServerConfig> {
  if (!isRecord(value)) throw new Error('Config must be an object');

  for (const key of Object.keys(value)) {
    if (!CONFIG_KEYS.has(key as keyof ServerConfig)) {
      throw new Error(`Unknown config key: ${key}`);
    }
  }

  const patch: Partial<ServerConfig> = {};
  if (Object.hasOwn(value, 'command')) {
    if (typeof value.command !== 'string' || value.command.trim() === '') {
      throw new Error('command must be a non-empty string');
    }
    patch.command = value.command;
  }
  if (Object.hasOwn(value, 'httpPort')) {
    patch.httpPort = validatePort('httpPort', value.httpPort);
  }
  if (Object.hasOwn(value, 'tcpPort')) {
    patch.tcpPort = validatePort('tcpPort', value.tcpPort);
  }
  if (Object.hasOwn(value, 'dataPath')) {
    if (typeof value.dataPath !== 'string') throw new Error('dataPath must be a string');
    patch.dataPath = value.dataPath;
  }
  if (Object.hasOwn(value, 'extraEnv')) {
    if (!isRecord(value.extraEnv)) {
      throw new Error('extraEnv must be an object containing only string values');
    }
    const entries = Object.entries(value.extraEnv);
    for (const [key, entry] of entries) {
      if (typeof entry !== 'string') {
        throw new Error(`extraEnv.${key} must be a string`);
      }
    }
    // fromEntries defines "__proto__" as ordinary data instead of invoking the
    // legacy Object.prototype setter via indexed assignment.
    patch.extraEnv = Object.fromEntries(entries) as Record<string, string>;
  }
  return patch;
}

/** Validate the complete snapshot start() is about to pass to the child. */
function validateServerConfig(value: unknown): ServerConfig {
  if (!isRecord(value)) throw new Error('Config must be an object');
  const config = validateConfigPatch(value);
  for (const key of CONFIG_KEYS) {
    if (!Object.hasOwn(value, key)) {
      throw new Error(`Missing config key: ${key}`);
    }
  }
  return config as ServerConfig;
}

function copyConfig(config: ServerConfig): ServerConfig {
  return { ...config, extraEnv: { ...config.extraEnv } };
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
  /**
   * The stop() currently in flight (null when none). A stop() still owns a live
   * child until its await resolves, so start() waits on this before spawning —
   * otherwise a start racing a stop leaves two managed servers alive at once,
   * fighting over the ports and the SQLite db.
   */
  private stopping: Promise<StatusSnapshot> | null = null;
  /** Latched by shutdown(): once set, start() refuses to spawn a new child. */
  private shuttingDown = false;
  /** Active stdout/stderr readers, grouped by the process generation they own. */
  private pipeReaders = new Map<number, Set<CancelablePipeReader>>();

  /**
   * Actively break pending reader.read() calls for a finished generation. A
   * descendant may inherit the child's pipe descriptor and keep it open after
   * the managed process exits; token checks alone cannot release that reader.
   */
  private cancelPipes(token: number): void {
    const readers = this.pipeReaders.get(token);
    if (!readers) return;
    this.pipeReaders.delete(token);
    for (const reader of readers) {
      void reader.cancel('process generation ended').catch(() => {
        /* already closed/cancelled */
      });
    }
  }

  getConfig(): ServerConfig {
    return copyConfig(this.config);
  }

  /**
   * Update the desired config. Editing while the server runs is allowed; the
   * change applies on the next start/restart (the live process keeps using
   * `runningConfig` until then). Ports/data-path of a live process cannot be
   * changed in place.
   */
  setConfig(patch: Partial<ServerConfig>): ServerConfig {
    const valid = validateConfigPatch(patch);
    this.config = {
      ...this.config,
      ...valid,
      extraEnv: valid.extraEnv ?? this.config.extraEnv,
    };
    return copyConfig(this.config);
  }

  getStatus(): StatusSnapshot {
    return {
      status: this.status,
      pid: this.proc?.pid ?? null,
      startedAt: this.startedAt,
      exitCode: this.exitCode,
      config: copyConfig(this.config),
      runningConfig: this.runningConfig ? copyConfig(this.runningConfig) : null,
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
    // Backstop byte cap (the reader also splits oversized chunks) so no single
    // entry can pin an unbounded amount of memory in the ring buffer.
    const capped = line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…[truncated]` : line;
    this.logs.push({ seq: this.seq++, ts: Date.now(), stream, line: capped });
    // Amortized trim: only splice once the buffer overshoots by a slack margin, so
    // steady-state logging isn't an O(n) array shift on every single line.
    if (this.logs.length > MAX_LOGS + 256) this.logs.splice(0, this.logs.length - MAX_LOGS);
  }

  async start(): Promise<StatusSnapshot> {
    if (this.shuttingDown) return this.getStatus();
    if (this.status === 'running' || this.status === 'starting') return this.getStatus();
    // Never spawn while a stop() still owns a live child: wait it out, then
    // re-check the guards (a concurrent start may have won the race meanwhile).
    if (this.stopping) await this.stopping;
    if (this.shuttingDown) return this.getStatus();
    // Read through a local: TS narrowed `this.status` at the guard above and
    // doesn't widen it across the await, but a concurrent start() can have
    // moved it in the meantime — that interleaving is exactly what this checks.
    const statusAfterWait = this.status as Status;
    if (statusAfterWait === 'running' || statusAfterWait === 'starting') return this.getStatus();

    // Validate the COMPLETE launch snapshot BEFORE mutating status / burning a
    // proc token. setConfig() already validates API patches, but defaultConfig()
    // also reads environment values; e.g. HTTP_PORT=70000 must not reach spawn.
    // Doing this later can wedge status at 'starting' and strand stale process
    // metadata when validation throws.
    const launchConfig = validateServerConfig(this.config);
    const parts = launchConfig.command.trim().split(/\s+/);
    const [cmd, ...args] = parts;

    this.status = 'starting';
    this.exitCode = null;
    const token = ++this.procToken;

    // extraEnv is spread FIRST so the explicit port/data-path config always
    // wins: otherwise a user env var named HTTP_PORT silently moved the child
    // while runningConfig (and the agent's /health probe) reported the old port.
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...launchConfig.extraEnv,
      HTTP_PORT: String(launchConfig.httpPort),
      TCP_PORT: String(launchConfig.tcpPort),
      BUNQUEUE_DATA_PATH: launchConfig.dataPath,
    };

    try {
      this.proc = Bun.spawn([cmd, ...args], {
        env,
        stdout: 'pipe',
        stderr: 'pipe',
        onExit: (_p, code) => {
          // Always tear down this generation's readers, even if shared state
          // already belongs to a replacement process.
          this.cancelPipes(token);
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
      // Leave a consistent stopped snapshot: without this, a spawn failure
      // racing an in-flight stop() (whose token is already stale, so its
      // finalizer returns early) leaves getStatus() reporting the previous
      // generation's dead pid and a non-null runningConfig.
      this.proc = null;
      this.runningConfig = null;
      throw new Error(`Failed to spawn "${cmd}": ${(e as Error).message}`);
    }

    this.startedAt = Date.now();
    this.status = 'running';
    this.runningConfig = copyConfig(launchConfig);
    this.push('sys', `started: ${launchConfig.command} (pid ${this.proc.pid})`);
    // stdout/stderr are spawned as pipes, so they are ReadableStreams at
    // runtime; Bun types them as a union that also includes a numeric fd.
    void this.pipe(this.proc.stdout as unknown as ReadableStream<Uint8Array>, 'stdout', token);
    void this.pipe(this.proc.stderr as unknown as ReadableStream<Uint8Array>, 'stderr', token);
    return this.getStatus();
  }

  private async pipe(
    stream: ReadableStream<Uint8Array>,
    name: 'stdout' | 'stderr',
    token: number
  ): Promise<void> {
    const reader = stream.getReader();
    let readers = this.pipeReaders.get(token);
    if (!readers) {
      readers = new Set();
      this.pipeReaders.set(token, readers);
    }
    readers.add(reader);
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      try {
        while (true) {
          const { done, value } = await reader.read();
          // A process can exit while a descendant keeps its inherited pipe
          // open. If a replacement has started by the time bytes arrive, those
          // bytes belong to the obsolete generation and must never enter the
          // current log view.
          if (this.procToken !== token) return;
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let i: number;
          while ((i = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, i);
            buffer = buffer.slice(i + 1);
            if (line.trim() && this.procToken === token) this.push(name, line);
          }
          // No newline in sight: flush in MAX_LINE slices instead of letting the
          // buffer (and the eventual single LogLine) grow to the whole output.
          while (buffer.length > MAX_LINE) {
            if (this.procToken !== token) return;
            this.push(name, buffer.slice(0, MAX_LINE));
            buffer = buffer.slice(MAX_LINE);
          }
        }
      } catch {
        /* stream closed */
      }
      if (this.procToken !== token) return;
      // Flush the final chunk when the stream ends without a trailing newline
      // (e.g. a crash cause written via a bare write()) — otherwise the last,
      // often most important, line never reaches the log buffer.
      const tail = buffer + decoder.decode();
      if (tail.trim() && this.procToken === token) this.push(name, tail);
    } finally {
      const activeReaders = this.pipeReaders.get(token);
      activeReaders?.delete(reader);
      if (activeReaders?.size === 0) this.pipeReaders.delete(token);
      reader.releaseLock();
    }
  }

  async stop(): Promise<StatusSnapshot> {
    // Publish the in-flight stop so a racing start() can await it (see
    // `stopping`). stopOnce() runs its synchronous prefix — including
    // status='stopping' and the SIGTERM — before we return the promise.
    const p = this.stopOnce();
    this.stopping = p;
    try {
      return await p;
    } finally {
      if (this.stopping === p) this.stopping = null;
    }
  }

  /**
   * Stop the managed server and latch the manager closed, so a start() racing
   * process shutdown (e.g. an in-flight restart() whose stop() resolves after
   * SIGINT) cannot spawn a child that would be orphaned by process.exit().
   */
  async shutdown(): Promise<StatusSnapshot> {
    this.shuttingDown = true;
    return this.stop();
  }

  private async stopOnce(): Promise<StatusSnapshot> {
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
    // Timer cleared either way (this is the COMMON path): a pending one keeps
    // the event loop alive for the full timeout after the race is decided.
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      proc.exited.then(() => false),
      new Promise<boolean>((r) => {
        stopTimer = setTimeout(() => r(true), STOP_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(stopTimer));
    // Always escalate to SIGKILL on the CAPTURED proc (never `this.proc`) so a
    // child that ignores SIGTERM is still reaped even if a concurrent start()
    // has since swapped in a new process — `proc` targets this generation only.
    if (timedOut) {
      this.push('sys', 'SIGTERM timed out, sending SIGKILL');
      proc.kill(9);
      // Bounded: a child wedged in uninterruptible sleep never resolves
      // `exited` even after SIGKILL, and start() now awaits this promise, so an
      // unbounded wait here would pin the manager at 'stopping' and hang every
      // later start() forever. Give up on the wait (not on the kill) and let the
      // state below finalize — the pid is already unusable. The timer is always
      // cleared: a pending one keeps the event loop alive after the race is
      // decided, which delays process exit for the whole timeout.
      let reapTimer: ReturnType<typeof setTimeout> | undefined;
      const reaped = await Promise.race([
        proc.exited.then(() => true),
        new Promise<boolean>((r) => {
          reapTimer = setTimeout(() => r(false), STOP_TIMEOUT_MS);
        }),
      ]).finally(() => clearTimeout(reapTimer));
      if (!reaped) this.push('sys', `pid ${proc.pid} did not exit after SIGKILL — giving up on it`);
    }
    // onExit normally performs this cancellation. Repeat it idempotently for
    // a process whose `exited` promise/callback never settles after SIGKILL.
    this.cancelPipes(token);
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
