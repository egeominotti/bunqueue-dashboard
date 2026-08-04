import type { ServerConfig } from '../manager';
import { validateBackupResult } from './resultValidation';
import { executeBackupOperation } from './workerFactory';

export type BackupOperation = 'status' | 'list' | 'now' | 'restore';

export interface BackupCommandResult {
  success: boolean;
  message: string;
  data?: unknown;
}

export interface BackupRunnerPort {
  execute(config: ServerConfig, operation: BackupOperation, key?: string): Promise<BackupCommandResult>;
  close(): Promise<void>;
}

export type BackupOperationExecutor = (
  environment: Record<string, string>,
  operation: BackupOperation,
  key: string | undefined,
  signal: AbortSignal
) => Promise<unknown>;

const COMMAND_TIMEOUT_MS = 120_000;

/** Owns exactly one cancellable local backup operation at a time. */
export class BunqueueBackupRunner implements BackupRunnerPort {
  private active: Promise<BackupCommandResult> | null = null;
  private controller: AbortController | null = null;
  private closed = false;
  private closing: Promise<void> | null = null;

  constructor(
    private readonly timeoutMs = COMMAND_TIMEOUT_MS,
    private readonly executor: BackupOperationExecutor = executeBackupOperation
  ) {}

  execute(
    config: ServerConfig,
    operation: BackupOperation,
    key?: string
  ): Promise<BackupCommandResult> {
    if (this.closed) return Promise.reject(new Error('Backup runner is closed'));
    if (this.active) return Promise.reject(new Error('Another backup operation is already running'));
    if (operation === 'restore' && !key) {
      return Promise.reject(new Error('Backup key is required for restore'));
    }

    const controller = new AbortController();
    this.controller = controller;
    const timeout = setTimeout(() => {
      controller.abort(new Error(`Bunqueue backup command timed out after ${this.timeoutMs} ms`));
    }, this.timeoutMs);
    const pending = this.executor(
      backupEnvironment(config),
      operation,
      key,
      controller.signal
    ).then((value) => validateBackupResult(value, operation));
    const active = pending.finally(() => {
      clearTimeout(timeout);
      if (this.active === active) this.active = null;
      if (this.controller === controller) this.controller = null;
    });
    this.active = active;
    return active;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.controller?.abort(
      new Error('Bunqueue backup command cancelled because the control agent is closing')
    );
    const active = this.active;
    this.closing = (async () => {
      await active?.catch(() => undefined);
    })();
    return this.closing;
  }
}

function backupEnvironment(config: ServerConfig): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    ...config.extraEnv,
    BUNQUEUE_DATA_PATH: config.dataPath,
    NO_COLOR: '1',
  };
}
