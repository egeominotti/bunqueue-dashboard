import pino from 'pino';
import pretty from 'pino-pretty';

/**
 * Shared structured logger for the Bun-side infra (the control agent and the
 * standalone server). Pretty, colorized output on an interactive terminal;
 * newline-delimited JSON everywhere else (piped, redirected, or under a
 * process manager) so logs stay machine-parseable in production.
 *
 * pino-pretty is attached as a synchronous *stream*, not a worker-thread
 * transport, so this also works inside the `bun build --compile` standalone
 * binary (a transport worker module isn't embedded by the compiler).
 *
 * Level is controlled by LOG_LEVEL (default "info").
 */
const level = process.env.LOG_LEVEL ?? 'info';

export const logger = process.stdout.isTTY
  ? pino(
      { level },
      pretty({ colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' })
    )
  : pino({ level });
