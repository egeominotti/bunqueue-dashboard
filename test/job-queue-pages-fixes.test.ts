import {
  cleanArgs,
  createElement,
  describe,
  duplicateKeys,
  expect,
  installTestHooks,
  JobActionsPanel,
  type JobFull,
  parseFailureStack,
  parseJobActionNumber,
  previewDelays,
  promoteCountArgs,
  rateLimitArgs,
  remainingRetries,
  render,
  test,
} from './job-queue-pages-fixes.helpers';

installTestHooks();

describe('JobBackoff — remaining attempts', () => {
  const job = (attempts: number, maxAttempts: number) =>
    ({ id: 'j', attempts, maxAttempts }) as JobFull;

  test('a never-run job with 11 max attempts has 10 retry rows, not 11', () => {
    // Pre-fix: remaining was maxAttempts - attempts = 11, so the page claimed
    // "Showing next 10 of 11" while nothing was actually hidden.
    expect(previewDelays(job(0, 11))).toHaveLength(10);
    expect(remainingRetries(job(0, 11))).toBe(10);
  });

  test('the notice only fires when rows were really truncated', () => {
    expect(remainingRetries(job(0, 12))).toBe(11); // 1 row hidden — notice is honest
    expect(previewDelays(job(0, 12))).toHaveLength(10);
  });

  test('a job that has already run is unchanged (remaining === max - attempts)', () => {
    expect(remainingRetries(job(3, 11))).toBe(8);
    expect(previewDelays(job(3, 11))).toHaveLength(8);
  });
});

describe('EnvVarsEditor — duplicate-key warning', () => {
  test('names each duplicated key exactly once regardless of repeat count', () => {
    expect(duplicateKeys(['API_KEY', 'API_KEY', 'API_KEY'])).toEqual(['API_KEY']);
    expect(duplicateKeys(['A', 'A', 'B', 'B', 'C'])).toEqual(['A', 'B']);
  });

  test('trims and ignores blank keys', () => {
    expect(duplicateKeys([' X ', 'X', '', '  '])).toEqual(['X']);
    expect(duplicateKeys(['A', 'B'])).toEqual([]);
  });
});

describe('QueueActions — Clean args match the confirm text', () => {
  test('a blank field is rejected instead of silently becoming 0', () => {
    // Number('') === 0, so pre-fix an emptied Grace field rendered a blank in
    // the prompt while sending grace:0 — the widest possible deletion scope.
    expect(cleanArgs('', '1000').valid).toBe(false);
    expect(cleanArgs('0', '').valid).toBe(false);
    expect(cleanArgs('  ', ' ').valid).toBe(false);
  });

  test('a limit of 0 (an unbounded purge on falsy-checking servers) is rejected', () => {
    expect(cleanArgs('0', '0').valid).toBe(false);
  });

  test('valid input coerces once, so prompt and request quote the same numbers', () => {
    const a = cleanArgs('60000', '500');
    expect(a).toEqual({ grace: 60000, limit: 500, valid: true });
  });

  test('fractional and unsafe integers are rejected', () => {
    expect(cleanArgs('1.5', '100').valid).toBe(false);
    expect(cleanArgs('100', '1.5').valid).toBe(false);
    expect(cleanArgs('9007199254740992', '1').valid).toBe(false);
  });
});

describe('QueueActions — promote count', () => {
  test('blank means all; a supplied count must be a positive safe integer', () => {
    expect(promoteCountArgs('')).toEqual({ valid: true });
    expect(promoteCountArgs('  ')).toEqual({ valid: true });
    expect(promoteCountArgs('1')).toEqual({ count: 1, valid: true });
    expect(promoteCountArgs('0').valid).toBe(false);
    expect(promoteCountArgs('-1').valid).toBe(false);
    expect(promoteCountArgs('1.5').valid).toBe(false);
    expect(promoteCountArgs('9007199254740992').valid).toBe(false);
  });
});

describe('QueueActions — rate-limit body', () => {
  test('keeps blank optionals absent and rejects invalid values', () => {
    expect(rateLimitArgs('100', '', '')).toEqual({ limit: 100, duration: 0, valid: false });
    expect(rateLimitArgs('100', '60000', '3600000')).toEqual({
      limit: 100,
      duration: 60000,
      ttl: 3600000,
      valid: true,
    });
    expect(rateLimitArgs('0', '', '').valid).toBe(false);
    expect(rateLimitArgs('10', '-1', '').valid).toBe(false);
    expect(rateLimitArgs('10', '', '1.5').valid).toBe(false);
    expect(rateLimitArgs('9007199254740992', '', '').valid).toBe(false);
  });
});

describe('JobActionsPanel — numeric request validation', () => {
  test('failed and completed jobs expose no retry or requeue control', () => {
    let actions = 0;
    for (const state of ['failed', 'completed']) {
      const { container, unmount } = render(
        createElement(JobActionsPanel, {
          job: { id: `${state}-job`, queue: 'orders', state },
          busy: false,
          act: () => {
            actions += 1;
          },
        })
      );
      expect(container.textContent).not.toContain('Retry from DLQ');
      expect(container.textContent).not.toContain('Requeue');
      expect(container.textContent).toContain('unavailable');
      unmount();
      container.remove();
    }
    expect(actions).toBe(0);
  });

  test('delay and priority stay inside server-safe integer bounds', () => {
    expect(parseJobActionNumber('0', 'delay')).toEqual({ ok: true, value: 0 });
    expect(parseJobActionNumber('31536000000', 'delay').ok).toBe(true);
    expect(parseJobActionNumber('-1', 'delay').ok).toBe(false);
    expect(parseJobActionNumber('1.5', 'delay').ok).toBe(false);
    expect(parseJobActionNumber('31536000001', 'delay').ok).toBe(false);
    expect(parseJobActionNumber('-1000000', 'priority').ok).toBe(true);
    expect(parseJobActionNumber('1000001', 'priority').ok).toBe(false);
    expect(parseJobActionNumber('1.5', 'priority').ok).toBe(false);
  });

  test('progress accepts finite values from 0 through 100 without clamping', () => {
    expect(parseJobActionNumber('12.5', 'progress')).toEqual({ ok: true, value: 12.5 });
    expect(parseJobActionNumber('-1', 'progress').ok).toBe(false);
    expect(parseJobActionNumber('101', 'progress').ok).toBe(false);
    expect(parseJobActionNumber('NaN', 'progress').ok).toBe(false);
    expect(parseJobActionNumber('', 'progress').ok).toBe(false);
  });
});

describe('JobActionsPanel — failure stack validation', () => {
  test('normalizes blank lines but never silently truncates frames', () => {
    expect(parseFailureStack(' frame one \n\n frame two ')).toEqual({
      ok: true,
      stack: ['frame one', 'frame two'],
    });
    expect(parseFailureStack('')).toEqual({ ok: true });
    expect(
      parseFailureStack(Array.from({ length: 100 }, (_, i) => `frame ${i}`).join('\n')).ok
    ).toBe(true);
    expect(
      parseFailureStack(Array.from({ length: 101 }, (_, i) => `frame ${i}`).join('\n')).ok
    ).toBe(false);
  });

  test('rejects pathological individual and aggregate stack sizes', () => {
    expect(parseFailureStack('x'.repeat(16_385)).ok).toBe(false);
    expect(
      parseFailureStack(Array.from({ length: 100 }, () => 'x'.repeat(3000)).join('\n')).ok
    ).toBe(false);
  });
});
