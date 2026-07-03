import { describe, expect, test } from 'bun:test';
import { nextCronRuns } from '../src/lib/cronPreview';

// A fixed base instant; assertions use LOCAL getters (matching the parser), so
// they hold regardless of the test machine's timezone.
const FROM = new Date(2026, 0, 1, 0, 0, 0).getTime();

describe('nextCronRuns — validation', () => {
  test('rejects the wrong field count', () => {
    expect(nextCronRuns('* * *', 3, FROM).valid).toBe(false);
    expect(nextCronRuns('* * * * * *', 3, FROM).valid).toBe(false);
  });

  test('rejects out-of-range values', () => {
    expect(nextCronRuns('99 * * * *', 3, FROM).valid).toBe(false);
    expect(nextCronRuns('* 25 * * *', 3, FROM).valid).toBe(false);
    expect(nextCronRuns('* * 32 * *', 3, FROM).valid).toBe(false);
  });

  test('rejects garbage tokens', () => {
    expect(nextCronRuns('a b c d e', 3, FROM).valid).toBe(false);
  });
});

describe('nextCronRuns — schedules', () => {
  test('daily at 09:00 → 3 runs, 24h apart, all at 09:00 local', () => {
    const { valid, runs } = nextCronRuns('0 9 * * *', 3, FROM);
    expect(valid).toBe(true);
    expect(runs).toHaveLength(3);
    for (const r of runs) {
      const d = new Date(r);
      expect(d.getHours()).toBe(9);
      expect(d.getMinutes()).toBe(0);
    }
    expect(runs[1] - runs[0]).toBe(24 * 60 * 60 * 1000);
    expect(runs[2] - runs[1]).toBe(24 * 60 * 60 * 1000);
  });

  test('every 15 minutes → minutes divisible by 15, 15m apart', () => {
    const { valid, runs } = nextCronRuns('*/15 * * * *', 4, FROM);
    expect(valid).toBe(true);
    expect(runs).toHaveLength(4);
    for (const r of runs) expect(new Date(r).getMinutes() % 15).toBe(0);
    expect(runs[1] - runs[0]).toBe(15 * 60 * 1000);
  });

  test('list of hours (0,12) restricts to those hours', () => {
    const { runs } = nextCronRuns('0 0,12 * * *', 4, FROM);
    for (const r of runs) expect([0, 12]).toContain(new Date(r).getHours());
  });

  test('weekday name (mon) fires only on Mondays', () => {
    const { runs } = nextCronRuns('0 9 * * mon', 3, FROM);
    for (const r of runs) expect(new Date(r).getDay()).toBe(1);
  });

  test('day-of-month restriction (1st) fires on the 1st', () => {
    const { runs } = nextCronRuns('0 0 1 * *', 2, FROM);
    for (const r of runs) expect(new Date(r).getDate()).toBe(1);
  });

  test('step in day-of-month (*/5) restricts to every 5th day — not every day', () => {
    const { valid, runs } = nextCronRuns('0 0 */5 * *', 6, FROM);
    expect(valid).toBe(true);
    // */5 over 1..31 → dates {1,6,11,16,21,26,31}
    for (const r of runs) expect([1, 6, 11, 16, 21, 26, 31]).toContain(new Date(r).getDate());
    // Consecutive runs must NOT be one day apart (the collapse-to-every-day bug).
    expect(runs[1] - runs[0]).toBeGreaterThanOrEqual(4 * 24 * 60 * 60 * 1000);
  });

  test('step in day-of-week (*/2) restricts to every other weekday value', () => {
    const { valid, runs } = nextCronRuns('0 0 * * */2', 5, FROM);
    expect(valid).toBe(true);
    // */2 over 0..6 → {0,2,4,6} = Sun, Tue, Thu, Sat
    for (const r of runs) expect([0, 2, 4, 6]).toContain(new Date(r).getDay());
  });

  test('all runs are strictly in the future and increasing', () => {
    const { runs } = nextCronRuns('*/5 * * * *', 5, FROM);
    expect(runs[0]).toBeGreaterThan(FROM);
    for (let i = 1; i < runs.length; i++) expect(runs[i]).toBeGreaterThan(runs[i - 1]);
  });
});
