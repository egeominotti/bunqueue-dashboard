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
const RESERVED_FIELDS = new Set(['level', 'time', 'msg', 'toJSON', 'logSerializationError']);
const UNSAFE_FIELDS = '[Unsafe log fields omitted]';
const UNSERIALIZABLE_FIELDS = '[Unserializable log fields]';

function json(value: unknown): string | null {
  const seen = new WeakSet<object>();
  try {
    return (
      JSON.stringify(value, (_key, current: unknown) => {
        if (typeof current === 'bigint') return current.toString();
        if (typeof current === 'symbol') return `[${String(current)}]`;
        if (typeof current === 'function') return `[Function ${current.name || 'anonymous'}]`;
        if (typeof current === 'object' && current !== null) {
          if (seen.has(current)) return '[Circular]';
          seen.add(current);
        }
        return current;
      }) ?? null
    );
  } catch {
    return null;
  }
}

function safeText(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return value === undefined ? '' : String(value);
  } catch {
    return '[Unprintable log message]';
  }
}

function safeFields(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') {
    return { value };
  }
  const fields: Record<string, unknown> = Object.create(null);
  let unsafe = false;
  let keys: PropertyKey[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return { logSerializationError: UNSERIALIZABLE_FIELDS };
  }
  for (const key of keys) {
    if (typeof key !== 'string') continue;
    if (RESERVED_FIELDS.has(key)) {
      unsafe = true;
      continue;
    }
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    } catch {
      return { logSerializationError: UNSERIALIZABLE_FIELDS };
    }
    if (!descriptor?.enumerable) continue;
    if ('value' in descriptor) fields[key] = descriptor.value;
    else {
      fields[key] = '[Accessor log field omitted]';
      unsafe = true;
    }
  }
  if (unsafe) fields.logSerializationError = UNSAFE_FIELDS;
  return fields;
}

function logLine(level: LogLevel, obj: unknown, msg: unknown): string {
  const time = Date.now();
  const record: Record<string, unknown> = Object.create(null);
  record.level = LEVELS[level];
  record.time = time;
  const fields = safeFields(obj);
  if (fields) {
    for (const [key, value] of Object.entries(fields)) record[key] = value;
  }
  record.msg = safeText(msg);
  const line = json(record);
  if (line) return line;
  return JSON.stringify({
    level: LEVELS[level],
    time,
    logSerializationError: UNSERIALIZABLE_FIELDS,
    msg: safeText(msg),
  });
}

function logArguments(a?: unknown, b?: unknown): { obj: unknown; msg: unknown } {
  // pino signature: (mergeObject, message) or just (message). An Error as the
  // first arg gets its message/stack lifted explicitly — Error props are
  // non-enumerable, so a plain spread would silently log `{}`.
  let obj: unknown;
  let msg: unknown;
  if (typeof a === 'string') {
    msg = a;
  } else {
    msg = b;
    try {
      obj =
        a instanceof Error
          ? { err: { name: a.name, message: a.message, stack: a.stack } }
          : (a as Record<string, unknown> | undefined);
    } catch {
      obj = { err: '[Uninspectable log argument]' };
    }
  }
  return { obj, msg };
}

export function formatLogEntry(level: LogLevel, a?: unknown, b?: unknown, tty = isTTY): string {
  const { obj, msg } = logArguments(a, b);
  if (tty) {
    const fieldsObject = safeFields(obj);
    const serialized = fieldsObject
      ? (json(fieldsObject) ?? JSON.stringify({ logSerializationError: UNSERIALIZABLE_FIELDS }))
      : null;
    const fields = serialized && serialized !== '{}' ? ` ${DIM}${serialized}${RESET}` : '';
    return `${DIM}${clock(new Date())}${RESET} ${COLORS[level]}${level.toUpperCase().padEnd(5)}${RESET} ${safeText(msg)}${fields}`;
  }
  return logLine(level, obj, msg);
}

function write(level: LogLevel, a?: unknown, b?: unknown): void {
  if (LEVELS[level] < threshold) return;
  console.log(formatLogEntry(level, a, b));
}

export const logger = {
  trace: (a?: unknown, b?: unknown): void => write('trace', a, b),
  debug: (a?: unknown, b?: unknown): void => write('debug', a, b),
  info: (a?: unknown, b?: unknown): void => write('info', a, b),
  warn: (a?: unknown, b?: unknown): void => write('warn', a, b),
  error: (a?: unknown, b?: unknown): void => write('error', a, b),
  fatal: (a?: unknown, b?: unknown): void => write('fatal', a, b),
};
