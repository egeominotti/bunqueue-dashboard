/**
 * Zero-dependency Bunqueue 2.9 cron parser + next-run preview. Used by CronManager to
 * validate an expression and show the operator the next few fire times BEFORE
 * they commit a schedule (a mistyped `9 0 * * *` vs `0 9 * * *` is otherwise only
 * discovered by watching the wrong hour never fire).
 *
 * Supports standard five-field `minute hour day-of-month month day-of-week`
 * expressions and Bun 1.4's leading-seconds six-field form:
 * `*`, lists (`1,15`), ranges (`1-5`), steps (`* / 5`, `0-30/10`), and case-
 * insensitive month/weekday names (`jan`, `mon`). Day-of-month and day-of-week
 * use Vixie-cron OR semantics when both are restricted. Times are computed in the
 * browser's LOCAL timezone (the common case); a server-side `timezone` is noted
 * separately in the UI rather than reinterpreted here.
 */

import { nextCalendarMinute, nextCalendarSecond, type CronCalendar } from './cronNext';

// Bun.cron accepts the exact three-letter abbreviation or the complete name,
// case-insensitively. Prefixes such as `janfoo` must not be normalized to Jan.
const MONTHS: Readonly<Record<string, number>> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};
const DOW: Readonly<Record<string, number>> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};
const CRON_SHORTCUTS: Readonly<Record<string, string>> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

interface ParsedField {
  values: Set<number>;
  star: boolean;
}

function parseField(
  raw: string,
  min: number,
  max: number,
  names?: Readonly<Record<string, number>>
): ParsedField | null {
  // Bun only treats the literal `*` as unrestricted for DOM/DOW matching.
  // A stepped wildcard such as `*/2` is a restriction and therefore takes
  // part in the usual OR rule when the other day field is also restricted.
  const star = raw === '*';
  const values = new Set<number>();
  for (const part of raw.split(',')) {
    const token = part.trim().toLowerCase();
    if (token === '') return null;
    const stepMatch = token.match(/^(.+)\/(\+?\d+)$/);
    const step = stepMatch ? Number(stepMatch[2]) : 1;
    const base = stepMatch ? stepMatch[1] : token;
    // Bun 1.4 stores five-field cron steps in a signed 8-bit slot.
    if (!Number.isSafeInteger(step) || step < 1 || step > 127) return null;

    let lo: number;
    let hi: number;
    if (base === '*') {
      lo = min;
      hi = max;
    } else if (base.includes('-')) {
      const range = base.split('-');
      if (range.length !== 2) return null;
      const [a, b] = range;
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

function resolveName(raw: string, names?: Readonly<Record<string, number>>): number | null {
  const s = raw.trim().toLowerCase();
  if (s === '') return null;
  if (names) {
    const value = names[s];
    if (value !== undefined) return value;
  }
  if (!/^\+?\d+$/.test(s)) return null;
  const value = Number(s);
  return Number.isSafeInteger(value) ? value : null;
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
  const trimmed = expr.trim();
  const expanded = CRON_SHORTCUTS[trimmed.toLowerCase()] ?? trimmed;
  const fields = expanded.split(/\s+/);
  if (fields.length !== 5 && fields.length !== 6) {
    return {
      valid: false,
      error: `Expected 5 fields (min hour day month weekday) or 6 with leading seconds, got ${fields.length}.`,
      runs: [],
    };
  }
  const hasSeconds = fields.length === 6;
  const offset = hasSeconds ? 1 : 0;
  const second = hasSeconds ? parseSecondsField(fields[0]) : fixedField(0);
  const minute = parseField(fields[offset], 0, 59);
  const hour = parseField(fields[offset + 1], 0, 23);
  const dom = parseField(fields[offset + 2], 1, 31);
  const month = parseField(fields[offset + 3], 1, 12, MONTHS);
  // Weekday: accept 0-7 (0 and 7 both Sunday) and names; normalize 7→0.
  const dowRaw = parseField(fields[offset + 4], 0, 7, DOW);
  if (!second || !minute || !hour || !dom || !month || !dowRaw) {
    return { valid: false, error: 'Invalid field syntax.', runs: [] };
  }
  const dowValues = new Set<number>();
  for (const v of dowRaw.values) dowValues.add(v === 7 ? 0 : v);
  const dow: ParsedField = { values: dowValues, star: dowRaw.star };

  const calendar: CronCalendar = {
    minute: { values: minute.values, literalWildcard: minute.star },
    hour: { values: hour.values, literalWildcard: hour.star },
    dayOfMonth: { values: dom.values, literalWildcard: dom.star },
    month: { values: month.values, literalWildcard: month.star },
    dayOfWeek: { values: dow.values, literalWildcard: dow.star },
  };

  const runs: number[] = [];
  const limit = Number.isSafeInteger(count) ? Math.max(0, Math.min(count, 100)) : 0;
  const seconds = [...second.values].sort((a, b) => a - b);
  let cursor = fromMs;
  while (runs.length < limit) {
    const next = hasSeconds
      ? nextCalendarSecond(calendar, seconds, cursor)
      : nextCalendarMinute(calendar, cursor);
    if (next === null || next <= cursor) break;
    runs.push(next);
    cursor = next;
  }
  return { valid: true, runs };
}

function fixedField(value: number): ParsedField {
  return { values: new Set([value]), star: false };
}

/** Mirrors Bunqueue 2.9's stricter leading-seconds grammar. */
function parseSecondsField(raw: string): ParsedField | null {
  const values = new Set<number>();
  for (const segment of raw.split(',')) {
    if (!segment) return null;
    const stepParts = segment.split('/');
    if (stepParts.length > 2 || !stepParts[0] || stepParts[1] === '') return null;
    const base = stepParts[0];
    const hasStep = stepParts.length === 2;
    if (hasStep && !/^\d+$/.test(stepParts[1])) return null;
    const step = hasStep ? Number(stepParts[1]) : 1;
    if (step < 1 || step > 60) return null;

    let lo: number;
    let hi: number;
    if (base === '*') {
      lo = 0;
      hi = 59;
    } else if (base.includes('-')) {
      const range = base.split('-');
      if (range.length !== 2 || !range[0] || !range[1]) return null;
      if (!/^\d+$/.test(range[0]) || !/^\d+$/.test(range[1])) return null;
      lo = Number(range[0]);
      hi = Number(range[1]);
    } else {
      if (hasStep || !/^\d+$/.test(base)) return null;
      lo = Number(base);
      hi = lo;
    }
    if (lo < 0 || hi > 59 || lo > hi) return null;
    for (let value = lo; value <= hi; value += step) values.add(value);
  }
  return values.size ? { values, star: raw === '*' || /^\*\/\d+$/.test(raw) } : null;
}
