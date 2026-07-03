/**
 * Zero-dependency 5-field cron parser + next-run preview. Used by CronManager to
 * validate an expression and show the operator the next few fire times BEFORE
 * they commit a schedule (a mistyped `9 0 * * *` vs `0 9 * * *` is otherwise only
 * discovered by watching the wrong hour never fire).
 *
 * Supports the standard `minute hour day-of-month month day-of-week` grammar:
 * `*`, lists (`1,15`), ranges (`1-5`), steps (`* / 5`, `0-30/10`), and case-
 * insensitive month/weekday names (`jan`, `mon`). Day-of-month and day-of-week
 * use Vixie-cron OR semantics when both are restricted. Times are computed in the
 * browser's LOCAL timezone (the common case); a server-side `timezone` is noted
 * separately in the UI rather than reinterpreted here.
 */

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

interface ParsedField {
  values: Set<number>;
  star: boolean;
}

function parseField(
  raw: string,
  min: number,
  max: number,
  names?: readonly string[]
): ParsedField | null {
  const star = raw === '*' || /^\*\/\d+$/.test(raw);
  const values = new Set<number>();
  for (const part of raw.split(',')) {
    const token = part.trim().toLowerCase();
    if (token === '') return null;
    const stepMatch = token.match(/^(.+)\/(\d+)$/);
    const step = stepMatch ? Number(stepMatch[2]) : 1;
    const base = stepMatch ? stepMatch[1] : token;
    if (step < 1) return null;

    let lo: number;
    let hi: number;
    if (base === '*') {
      lo = min;
      hi = max;
    } else if (base.includes('-')) {
      const [a, b] = base.split('-');
      const av = resolveName(a, names);
      const bv = resolveName(b, names);
      if (av == null || bv == null) return null;
      lo = av;
      hi = bv;
    } else {
      const v = resolveName(base, names);
      if (v == null) return null;
      lo = v;
      // `a/n` (single value with a step) means `a-max/n`.
      hi = stepMatch ? max : v;
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return values.size ? { values, star } : null;
}

function resolveName(raw: string, names?: readonly string[]): number | null {
  const s = raw.trim().toLowerCase();
  if (s === '') return null;
  if (names) {
    const idx = names.indexOf(s.slice(0, 3));
    if (idx !== -1) return idx;
  }
  if (!/^\d+$/.test(s)) return null;
  return Number(s);
}

export interface CronParseResult {
  valid: boolean;
  error?: string;
  /** Epoch-ms of the next N fire times (empty when invalid or none found in range). */
  runs: number[];
}

/**
 * Parse `expr` and compute the next `count` fire times after `fromMs` (default
 * now must be supplied by the caller — this module is pure and takes no clock).
 */
export function nextCronRuns(expr: string, count: number, fromMs: number): CronParseResult {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    return {
      valid: false,
      error: `Expected 5 fields (min hour day month weekday), got ${fields.length}.`,
      runs: [],
    };
  }
  const minute = parseField(fields[0], 0, 59);
  const hour = parseField(fields[1], 0, 23);
  const dom = parseField(fields[2], 1, 31);
  const month = parseField(fields[3], 1, 12, MONTHS);
  // Weekday: accept 0-7 (0 and 7 both Sunday) and names; normalize 7→0.
  const dowRaw = parseField(fields[4], 0, 7, DOW);
  if (!minute || !hour || !dom || !month || !dowRaw) {
    return { valid: false, error: 'Invalid field syntax.', runs: [] };
  }
  const dowValues = new Set<number>();
  for (const v of dowRaw.values) dowValues.add(v === 7 ? 0 : v);
  const dow: ParsedField = { values: dowValues, star: dowRaw.star };

  // Vixie-cron day semantics: when EITHER the day-of-month or day-of-week field
  // begins with `*` (including the `*/N` step form), the two are AND-ed; when both
  // are explicit lists/ranges they are OR-ed. Both branches always consult the
  // parsed value sets, so a `*/5` day-of-month still restricts to every 5th day
  // rather than collapsing to "every day".
  const dayMatches = (d: Date): boolean => {
    const domOk = dom.values.has(d.getDate());
    const dowOk = dow.values.has(d.getDay());
    return dom.star || dow.star ? domOk && dowOk : domOk || dowOk;
  };

  const runs: number[] = [];
  const d = new Date(fromMs);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  // Bounded search (>4 years of minutes) so a pathological expression can't spin.
  for (let guard = 0; guard < 2_200_000 && runs.length < count; guard++) {
    if (!month.values.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!hour.values.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!minute.values.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
      continue;
    }
    runs.push(d.getTime());
    d.setMinutes(d.getMinutes() + 1, 0, 0);
  }
  return { valid: true, runs };
}
