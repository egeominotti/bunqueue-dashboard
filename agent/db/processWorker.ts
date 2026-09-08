import { fileURLToPath } from 'node:url';
import { deserialize, serialize } from 'node:v8';
import { readBoundedBytes } from './boundedStream';
import { isCompiledModule } from '../compiledRuntime';

type WorkerEvents = {
  message: { data: unknown };
  error: { message: string; preventDefault?: () => void };
  close: Record<string, never>;
};

/** Minimal Worker-compatible seam retained for existing integrations and fault injection. */
export interface DatabaseWorker {
  addEventListener<K extends keyof WorkerEvents>(type: K, listener: (event: WorkerEvents[K]) => void): void;
  postMessage(request: unknown): void;
  terminate(): void;
  /** Production workers resolve only after the OS has reaped the child. */
  exited?: Promise<void>;
}

const active = new Set<DatabaseProcessWorker>();
export const databaseProcessLoad = (): number => active.size;
export function terminateDatabaseProcesses(): void {
  for (const worker of active) worker.terminate();
}
process.once('exit', terminateDatabaseProcesses);

/** Unlike Worker.terminate(), SIGKILL interrupts synchronous sqlite3_step. */
export class DatabaseProcessWorker implements DatabaseWorker {
  private listeners = new Map<string, Array<(event: unknown) => void>>();
  private child?: Bun.Subprocess<'ignore', 'pipe', 'ignore' | 'inherit'>;
  private stopped = false;
  private started = false;
  private closed = false;
  private resolveExit!: () => void;
  readonly exited = new Promise<void>((resolve) => { this.resolveExit = resolve; });
  get pid(): number | undefined { return this.child?.pid; }

  addEventListener<K extends keyof WorkerEvents>(type: K, listener: (event: WorkerEvents[K]) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), (event) => listener(event as WorkerEvents[K])]);
  }

  postMessage(request: unknown): void {
    if (this.started || this.stopped) throw new Error('Database process is already used');
    this.started = true;
    active.add(this);
    void this.run(request);
  }

  terminate(): void {
    this.stopped = true;
    if (this.child && this.child.exitCode === null) this.child.kill('SIGKILL');
    if (!this.started) this.close();
  }

  private emit<K extends keyof WorkerEvents>(type: K, event: WorkerEvents[K]): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    active.delete(this);
    this.resolveExit();
    this.emit('close', {});
    this.listeners.clear();
  }

  private async run(request: unknown): Promise<void> {
    try {
      const message = request as Record<string, unknown>;
      const operation = message.operation ? request : message.kind === 'export'
        ? { operation: 'dbExportCsv', args: [message.path, message.table, message.orderBy, message.dir, message.filter] }
        : { operation: 'dbQuery', args: [message.path, message.sql] };
      const input = serialize(operation);
      if (input.byteLength > 128 * 1024) throw new Error('Database request exceeds 128 KiB');
      const compiled = isCompiledModule(import.meta.url);
      const trace = process.env.BQ_DB_PROCESS_TRACE === '1';
      if (trace) console.error(JSON.stringify({ component: 'db-process', phase: 'spawn', module: import.meta.url, compiled, executable: process.execPath }));
      let delivered = false;
      this.child = Bun.spawn(compiled
        ? [process.execPath, '--bq-db-read']
        : [process.execPath, fileURLToPath(new URL('./readProcessMain.ts', import.meta.url))], {
        // Database readers need no managed-server tokens or cloud credentials.
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMPDIR: process.env.TMPDIR, BQ_DB_PROCESS_TRACE: trace ? '1' : undefined },
        stdin: 'ignore', stdout: 'pipe', stderr: trace ? 'inherit' : 'ignore',
        ipc: (message, subprocess) => {
          if (message !== 'ready' || delivered || this.stopped) return;
          delivered = true;
          if (trace) console.error(JSON.stringify({ component: 'db-process', phase: 'ready', pid: subprocess.pid }));
          try { subprocess.send(input); } catch { this.terminate(); }
        },
      });
      const [output, code] = await Promise.all([
        readBoundedBytes(this.child.stdout, 32 * 1024 * 1024), this.child.exited,
      ]);
      if (trace) console.error(JSON.stringify({ component: 'db-process', phase: 'exited', code, bytes: output.byteLength }));
      if (this.stopped) return;
      if (code !== 0) throw new Error(`Database process exited with code ${code}`);
      const response = deserialize(output) as Record<string, unknown>;
      if (message.kind === 'export' && response.ok) response.export = response.result;
      // The process has exited before any caller can release its lifecycle lease.
      this.emit('message', { data: response });
    } catch (error) {
      this.terminate();
      if (this.child) await this.child.exited;
      this.emit('error', { message: error instanceof Error ? error.message : 'Database process failed' });
    } finally {
      try { this.child?.disconnect(); } catch { /* child already closed its IPC channel */ }
      this.child = undefined;
      this.close();
    }
  }
}
