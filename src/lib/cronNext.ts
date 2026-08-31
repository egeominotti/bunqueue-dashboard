export interface CronFieldSet {
  values: ReadonlySet<number>;
  literalWildcard: boolean;
}

export interface CronCalendar {
  minute: CronFieldSet;
  hour: CronFieldSet;
  dayOfMonth: CronFieldSet;
  month: CronFieldSet;
  dayOfWeek: CronFieldSet;
}

interface CivilMinute {
  year: number;
  month: number;
  day: number;
  weekday: number;
  hour: number;
  minute: number;
}

const MINUTE_MS = 60_000;
const MAX_DST_SHIFT_MINUTES = 120;

function toCivil(date: Date): CivilMinute {
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    weekday: date.getDay(),
    hour: date.getHours(),
    minute: date.getMinutes(),
  };
}

function normalizeCivil(value: CivilMinute): void {
  if (value.minute > 59) {
    value.minute -= 60;
    value.hour += 1;
  }
  if (value.hour > 23) {
    value.hour -= 24;
    value.day += 1;
  }
  // UTC noon is pure calendar arithmetic: local DST cannot alter the date.
  const normalized = new Date(Date.UTC(value.year, value.month - 1, value.day, 12));
  value.year = normalized.getUTCFullYear();
  value.month = normalized.getUTCMonth() + 1;
  value.day = normalized.getUTCDate();
  value.weekday = normalized.getUTCDay();
}

function dayMatches(calendar: CronCalendar, day: number, weekday: number): boolean {
  const domOk = calendar.dayOfMonth.values.has(day);
  const dowOk = calendar.dayOfWeek.values.has(weekday);
  return calendar.dayOfMonth.literalWildcard || calendar.dayOfWeek.literalWildcard
    ? domOk && dowOk
    : domOk || dowOk;
}

function instantMatches(calendar: CronCalendar, epochMs: number): boolean {
  const value = new Date(epochMs);
  return (
    calendar.minute.values.has(value.getMinutes()) &&
    calendar.hour.values.has(value.getHours()) &&
    calendar.month.values.has(value.getMonth() + 1) &&
    dayMatches(calendar, value.getDate(), value.getDay())
  );
}

function isComplete(field: CronFieldSet, size: number): boolean {
  return field.values.size === size;
}

function resolveLocalMinute(
  calendar: CronCalendar,
  value: CivilMinute,
  fromMs: number,
  from: CivilMinute
): number | null {
  const result = new Date(
    value.year,
    value.month - 1,
    value.day,
    value.hour,
    value.minute,
    0,
    0
  ).getTime();

  // Bun 1.4/cronie semantics: fixed schedules fire once in a repeated hour,
  // while a complete minute or hour field continues through both occurrences.
  if (isComplete(calendar.minute, 60) || isComplete(calendar.hour, 24)) {
    const wallFrom = Date.UTC(from.year, from.month - 1, from.day, from.hour, from.minute);
    const wallValue = Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute);
    if (result <= fromMs || result - fromMs > wallValue - wallFrom) {
      let probe = (Math.floor(fromMs / MINUTE_MS) + 1) * MINUTE_MS;
      let cap = fromMs + (MAX_DST_SHIFT_MINUTES + 1) * MINUTE_MS;
      if (result > fromMs) cap = Math.min(cap, result);
      while (probe < cap) {
        if (instantMatches(calendar, probe)) return probe;
        probe += MINUTE_MS;
      }
    }
  }
  return result > fromMs ? result : null;
}

/** Browser-local port of Bun 1.4's strictly-after calendar-minute search. */
export function nextCalendarMinute(calendar: CronCalendar, fromMs: number): number | null {
  if (!Number.isFinite(fromMs)) return null;
  const from = toCivil(new Date(fromMs));
  const value = { ...from, minute: from.minute + 1 };
  const lastYear = from.year + 8;

  for (let guard = 0; guard < 100_000 && value.year <= lastYear; guard++) {
    normalizeCivil(value);
    if (!calendar.month.values.has(value.month)) {
      value.month += 1;
      value.day = 1;
      value.hour = 0;
      value.minute = 0;
      continue;
    }
    if (!dayMatches(calendar, value.day, value.weekday)) {
      value.day += 1;
      value.hour = 0;
      value.minute = 0;
      continue;
    }
    if (!calendar.hour.values.has(value.hour)) {
      value.hour += 1;
      value.minute = 0;
      continue;
    }
    if (!calendar.minute.values.has(value.minute)) {
      value.minute += 1;
      continue;
    }
    const resolved = resolveLocalMinute(calendar, value, fromMs, from);
    if (resolved !== null) return resolved;
    value.minute += 1;
  }
  return null;
}

/** Mirrors Bunqueue 2.9: find a Bun calendar minute, then select its second. */
export function nextCalendarSecond(
  calendar: CronCalendar,
  seconds: readonly number[],
  fromMs: number
): number | null {
  const currentMinute = Math.floor(fromMs / MINUTE_MS) * MINUTE_MS;
  let matchingMinute = nextCalendarMinute(calendar, currentMinute - 1);
  while (matchingMinute !== null) {
    for (const second of seconds) {
      const candidate = matchingMinute + second * 1_000;
      if (candidate > fromMs) return candidate;
    }
    const nextMinute = nextCalendarMinute(calendar, matchingMinute);
    if (nextMinute === null || nextMinute <= matchingMinute) return null;
    matchingMinute = nextMinute;
  }
  return null;
}
