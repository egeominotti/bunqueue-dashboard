/**
 * Shared structured logger for the Bun-side infra (the control agent and the
 * standalone server). Pretty, colorized output on an interactive terminal;
 * newline-delimited JSON everywhere else (piped, redirected, or under a
 * process manager) so logs stay machine-parseable in production.
 *
 * Dependency-free on purpose: this file ships in the npm package, and it
 * replaced pino/pino-pretty as the package's ONLY runtime dependencies —
 * dropping them makes `bunx bunqueue-dashboard` a zero-dependency install.
 * The call signature (`logger.info(obj, msg)` / `logger.info(msg)`) and the
 * NDJSON shape (numeric `level`, `time`, `msg`, merged fields) stay
 * pino-compatible so nothing downstream changes.
 *
 * Level is controlled by LOG_LEVEL (default "info").
 */

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

// pino's numeric levels, kept for NDJSON parity with what we emitted before.
const LEVELS: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

const COLORS: Record<LogLevel, string> = {
  trace: '\u001b[90m',
  debug: '\u001b[36m',
  info: '\u001b[32m',
  warn: '\u001b[33m',
  error: '\u001b[31m',
  fatal: '\u001b[35m',
};
const RESET = '\u001b[0m';
const DIM = '\u001b[2m';

const threshold = LEVELS[(process.env.LOG_LEVEL ?? 'info') as LogLevel] ?? LEVELS.info;
const isTTY = !!process.stdout.isTTY;

const pad2 = (n: number): string => String(n).padStart(2, '0');
const clock = (d: Date): string => `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;

function write(level: LogLevel, a?: unknown, b?: unknown): void {
  if (LEVELS[level] < threshold) return;
  // pino signature: (mergeObject, message) or just (message). An Error as the
  // first arg gets its message/stack lifted explicitly — Error props are
  // non-enumerable, so a plain spread would silently log `{}`.
  const [obj, msg] =
    typeof a === 'string'
      ? [undefined, a]
      : a instanceof Error
        ? [{ err: { message: a.message, stack: a.stack } }, b as string | undefined]
        : [a as Record<string, unknown> | undefined, b as string | undefined];

  if (isTTY) {
    const fields = obj && Object.keys(obj).length ? ` ${DIM}${JSON.stringify(obj)}${RESET}` : '';
    console.log(
      `${DIM}${clock(new Date())}${RESET} ${COLORS[level]}${level.toUpperCase().padEnd(5)}${RESET} ${msg ?? ''}${fields}`
    );
    return;
  }
  console.log(
    JSON.stringify({ level: LEVELS[level], time: Date.now(), ...(obj ?? {}), msg: msg ?? '' })
  );
}

export const logger = {
  trace: (a?: unknown, b?: unknown): void => write('trace', a, b),
  debug: (a?: unknown, b?: unknown): void => write('debug', a, b),
  info: (a?: unknown, b?: unknown): void => write('info', a, b),
  warn: (a?: unknown, b?: unknown): void => write('warn', a, b),
  error: (a?: unknown, b?: unknown): void => write('error', a, b),
  fatal: (a?: unknown, b?: unknown): void => write('fatal', a, b),
};
