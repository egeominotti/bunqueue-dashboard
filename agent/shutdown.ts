import { logger } from './logger';
import { safeErrorMessage } from './errorMessage';
import type { AgentFetchHandler } from './server';

const DEFAULT_GRACE_MS = 30_000;

export interface AgentShutdownOptions {
  /** Stop listeners synchronously; returned promises drain in-flight HTTP requests. */
  stopAccepting?: Array<() => unknown | Promise<unknown>>;
  graceMs?: number;
  /** Test seam; production uses process.exit. */
  exit?: (code: number) => void;
}

/** Install one idempotent terminal shutdown path for agent entrypoints. */
export function installAgentShutdown(
  handle: AgentFetchHandler,
  options: AgentShutdownOptions = {}
): void {
  const shutdown = createAgentShutdown(handle, options);
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

/** Build the signal callback separately so ordering and exit codes are testable. */
export function createAgentShutdown(
  handle: AgentFetchHandler,
  options: AgentShutdownOptions = {}
): (signal: string) => void {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  let shuttingDown = false;
  let finished = false;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;

  return (signal) => {
    if (shuttingDown) {
      logger.error({ signal }, 'second signal received, forcing agent shutdown');
      force();
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, 'signal received, draining agent and managed server');

    const drains = (options.stopAccepting ?? []).map(invoke);
    const beginning = invoke(() => handle.beginShutdown());
    void beginning.catch(() => undefined);
    graceTimer = setTimeout(() => {
      logger.error({ graceMs }, 'agent shutdown grace period expired');
      force();
    }, graceMs);

    void finishShutdown(handle, beginning, drains).then(
      () => finish(0),
      (error) => {
        logger.error({ err: errorDetails(error) }, 'agent shutdown completed with errors');
        finish(1);
      }
    );
  };

  function finish(code: number): void {
    if (finished) return;
    finished = true;
    if (graceTimer) clearTimeout(graceTimer);
    graceTimer = null;
    exit(code);
  }

  function force(): void {
    if (finished) return;
    try {
      handle.forceShutdown();
    } catch (error) {
      logger.error({ err: errorDetails(error) }, 'failed to force-stop managed server');
    }
    finish(1);
  }
}

async function finishShutdown(
  handle: AgentFetchHandler,
  beginning: Promise<unknown>,
  drains: Promise<unknown>[]
): Promise<void> {
  // Start managed shutdown immediately: long-lived /api event streams only
  // finish after their upstream Bunqueue child stops, so waiting for HTTP
  // drain first would deadlock terminal shutdown.
  const shutdown = settled(() => handle.shutdown());
  const drained = await Promise.allSettled([beginning, ...drains]);
  const shutdownResult = await shutdown;
  const failures: unknown[] = [];
  for (const result of drained) {
    if (result.status === 'rejected') addFailure(failures, result.reason);
  }
  if (!shutdownResult.ok) addFailure(failures, shutdownResult.error);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, 'HTTP drain and agent shutdown failed');
  }
}

function addFailure(failures: unknown[], failure: unknown): void {
  if (!failures.some((current) => Object.is(current, failure))) failures.push(failure);
}

function invoke(operation: () => unknown | Promise<unknown>): Promise<unknown> {
  try {
    return Promise.resolve(operation());
  } catch (error) {
    return Promise.reject(error);
  }
}

type SettledOperation = { ok: true } | { ok: false; error: unknown };

async function settled(operation: () => Promise<unknown>): Promise<SettledOperation> {
  try {
    await operation();
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

function errorDetails(error: unknown, seen = new Set<object>()): unknown {
  try {
    if (typeof error === 'object' && error !== null) {
      if (seen.has(error)) return { type: 'circular', value: '[Circular rejection]' };
      seen.add(error);
    }
    if (error instanceof AggregateError) {
      return {
        name: safeField(error.name),
        message: safeErrorMessage(error),
        stack: safeField(error.stack),
        errors: error.errors.map((cause) => errorDetails(cause, seen)),
      };
    }
    if (error instanceof Error) {
      return {
        name: safeField(error.name),
        message: safeErrorMessage(error),
        stack: safeField(error.stack),
      };
    }
    return { type: error === null ? 'null' : typeof error, value: safeErrorMessage(error) };
  } catch {
    return { type: 'uninspectable', value: safeErrorMessage(error) };
  }
}

function safeField(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return safeErrorMessage(value);
}
