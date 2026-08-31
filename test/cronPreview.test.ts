import { describe, expect, test } from 'bun:test';
import { nextCronRuns } from '../src/lib/cronPreview';

// A fixed base instant; assertions use LOCAL getters (matching the parser), so
// they hold regardless of the test machine's timezone.
const FROM = new Date(2026, 0, 1, 0, 0, 0).getTime();

describe('nextCronRuns — validation', () => {
  test('rejects the wrong field count', () => {
    expect(nextCronRuns('* * *', 3, FROM).valid).toBe(false);
    expect(nextCronRuns('* * * * * * *', 3, FROM).valid).toBe(false);
  });

  test('rejects out-of-range values', () => {
    expect(nextCronRuns('99 * * * *', 3, FROM).valid).toBe(false);
    expect(nextCronRuns('* 25 * * *', 3, FROM).valid).toBe(false);
    expect(nextCronRuns('* * 32 * *', 3, FROM).valid).toBe(false);
  });

  test('rejects garbage tokens', () => {
    expect(nextCronRuns('a b c d e', 3, FROM).valid).toBe(false);
  });

  test('matches Bunqueue 2.9 leading-seconds step grammar', () => {
    expect(nextCronRuns('5/10 * * * * *', 3, FROM).valid).toBe(false);
    expect(nextCronRuns('*/61 * * * * *', 3, FROM).valid).toBe(false);
    expect(nextCronRuns('0-30/10 * * * * *', 3, FROM).valid).toBe(true);
  });

  test('matches Bun 1.4 exact names and bounded five-field steps', () => {
    const expressions = [
      '0 0 * januaryzzz *',
      '0 0 * janfoo *',
      '*/9999999999999999999999 * * * *',
      '*/128 * * * *',
      '0 0 * january monday',
      '*/127 * * * *',
      '+1 * * * *',
      '+1-+5/+2 * * * *',
      '*/+2 * * * *',
    ];
    for (const expression of expressions) {
      let bunAccepts = true;
      try {
        Bun.cron.parse(expression);
      } catch {
        bunAccepts = false;
      }
      expect(nextCronRuns(expression, 1, FROM).valid).toBe(bunAccepts);
    }
  });
});

describe('nextCronRuns — schedules', () => {
  test('matches Bun 1.4 validity and next timestamps for combined five-field rules', () => {
    const from = new Date(2026, 0, 1, 0, 0, 30).getTime();
    const expressions = [
      '0 0 */2 * 1',
      '0 0 1 * 1',
      '0 9 * jan mon',
      '+1,+15 * * * *',
      '*/+7 8-18/2 * * 1-5',
    ];

    for (const expression of expressions) {
      let expected: Date | null = null;
      let bunAccepts = true;
      try {
        expected = Bun.cron.parse(expression, from);
      } catch {
        bunAccepts = false;
      }
      const actual = nextCronRuns(expression, 1, from);
      expect(actual.valid).toBe(bunAccepts);
      expect(actual.runs[0]).toBe(expected?.getTime());
    }
  });

  test('six-field day rules preserve Bun five-field next timestamps', () => {
    const from = new Date(2026, 0, 1, 0, 0, 30).getTime();
    const pairs = [
      ['0 0 0 */2 * 1', '0 0 */2 * 1'],
      ['0 0 0 1 * 1', '0 0 1 * 1'],
      ['0 0 9 * jan mon', '0 9 * jan mon'],
    ] as const;

    for (const [sixField, fiveField] of pairs) {
      const expected = Bun.cron.parse(fiveField, from);
      const actual = nextCronRuns(sixField, 1, from);
      expect(actual.valid).toBe(true);
      expect(actual.runs[0]).toBe(expected?.getTime());
    }
  });

  test('matches Bun and stays monotonic across Europe/Rome DST transitions', () => {
    const moduleUrl = new URL('../src/lib/cronPreview.ts', import.meta.url).href;
    const cases = [
      ['0 2 * * *', '2026-03-28T21:30:00Z'],
      ['30 2 * * *', '2026-10-25T01:20:00Z'],
      ['* 2 * * *', '2026-10-25T01:20:00Z'],
      ['30 * * * *', '2026-10-25T01:20:00Z'],
    ];
    const script = `
      import { nextCronRuns } from ${JSON.stringify(moduleUrl)};
      const cases = ${JSON.stringify(cases)};
      const result = cases.map(([expression, iso]) => {
        const from = Date.parse(iso);
        const expected = Bun.cron.parse(expression, from)?.getTime();
        const actual = nextCronRuns(expression, 3, from).runs;
        return { expression, from, expected, actual };
      });
      const sixCases = [
        ['30 0 2 * * *', '0 2 * * *', '2026-03-28T21:30:00Z'],
        ['30 30 2 * * *', '30 2 * * *', '2026-10-25T01:20:00Z'],
      ];
      const six = sixCases.map(([expression, calendar, iso]) => {
        const from = Date.parse(iso);
        const minute = Bun.cron.parse(calendar, from).getTime();
        return { from, expected: minute + 30_000, actual: nextCronRuns(expression, 2, from).runs };
      });
      process.stdout.write(JSON.stringify({ result, six }));
    `;
    const child = Bun.spawnSync({
      cmd: [process.execPath, '-e', script],
      cwd: new URL('..', import.meta.url).pathname,
      env: { ...process.env, TZ: 'Europe/Rome' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(child.exitCode).toBe(0);
    const output = JSON.parse(child.stdout.toString()) as {
      result: { from: number; expected: number; actual: number[] }[];
      six: { from: number; expected: number; actual: number[] }[];
    };
    for (const { from, expected, actual } of output.result) {
      expect(actual[0]).toBe(expected);
      expect(actual.every((run) => run > from)).toBe(true);
      expect(actual[1]).toBeGreaterThan(actual[0]);
      expect(actual[2]).toBeGreaterThan(actual[1]);
    }
    for (const { from, expected, actual } of output.six) {
      expect(actual[0]).toBe(expected);
      expect(actual[0]).toBeGreaterThan(from);
      expect(actual[1]).toBeGreaterThan(actual[0]);
    }
  });

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

  test('six-field expressions use leading seconds', () => {
    const { valid, runs } = nextCronRuns('*/10 * * * * *', 4, FROM);
    expect(valid).toBe(true);
    expect(runs).toHaveLength(4);
    for (const run of runs) expect(new Date(run).getSeconds() % 10).toBe(0);
    expect(runs[1] - runs[0]).toBe(10_000);
  });

  test('official Bunqueue shortcuts expand before preview', () => {
    const { valid, runs } = nextCronRuns('@hourly', 3, FROM);
    expect(valid).toBe(true);
    expect(runs).toHaveLength(3);
    for (const run of runs) expect(new Date(run).getMinutes()).toBe(0);
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

  test('month names resolve to the right month (jan=1 … dec=12)', () => {
    // Regression: a 0-indexed MONTHS table rejected `jan` outright (0 < min 1)
    // and shifted every other name one month early (feb→Jan, dec→Nov).
    const jan = nextCronRuns('0 0 1 jan *', 1, FROM);
    expect(jan.valid).toBe(true);
    expect(new Date(jan.runs[0]).getMonth()).toBe(0); // January
    const feb = nextCronRuns('0 0 1 feb *', 1, FROM);
    expect(feb.valid).toBe(true);
    expect(new Date(feb.runs[0]).getMonth()).toBe(1); // February
    const dec = nextCronRuns('0 0 1 dec *', 1, FROM);
    expect(dec.valid).toBe(true);
    expect(new Date(dec.runs[0]).getMonth()).toBe(11); // December
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
