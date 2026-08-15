import {
  acceptedBulkIds,
  acceptedJobId,
  createdSummary,
  describe,
  expect,
  parseAddJobNumbers,
  parseRepeat,
  queueNameError,
  resolveBackoff,
  test,
} from './mutating-forms-fixes.helpers';

// Regression tests for the "mutating forms" audit package: submit what you
// validated, never report a silent drop as a success, and keep pagination /
// confirmation state honest.

describe('AddJob', () => {
  test('a backoff strategy without a base delay is rejected, not dropped', () => {
    const r = resolveBackoff(undefined, 'exponential');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.msg).toContain('Backoff (ms)');
  });

  test('a blank backoff with no strategy still means "server default"', () => {
    expect(resolveBackoff(undefined, '')).toEqual({ ok: true, backoff: undefined });
  });

  test('a delay + strategy becomes the structured backoff', () => {
    expect(resolveBackoff(1000, 'fixed')).toEqual({
      ok: true,
      backoff: { type: 'fixed', delay: 1000 },
    });
    expect(resolveBackoff(1000, '')).toEqual({ ok: true, backoff: 1000 });
  });

  test('the PUSHB summary reports only facts and never infers persisted jobs from ids', () => {
    expect(createdSummary(50, 50)).toEqual({
      ok: true,
      msg: 'Accepted 50 job submissions; server returned 50 distinct job IDs (deduplication may reuse existing jobs)',
    });
    const short = createdSummary(497, 500);
    expect(short.ok).toBe(true);
    expect(short.msg).toContain('Accepted 500 job submissions');
    expect(short.msg).toContain('497 distinct job IDs');
    expect(short.msg).not.toContain('Created');
  });

  test('rejects malformed single and bulk success envelopes', () => {
    expect(acceptedJobId({ ok: true, id: 'job-1' })).toBe('job-1');
    expect(() => acceptedJobId({ ok: true })).toThrow('malformed success response');
    expect(acceptedBulkIds({ ok: true, ids: ['a', 'a'] }, 2)).toEqual(['a', 'a']);
    expect(() => acceptedBulkIds({ ok: true, ids: ['a'] }, 2)).toThrow(
      'malformed success response'
    );
  });

  test('repeat input only accepts the v2.8.55-safe every/limit subset', () => {
    expect(parseRepeat('')).toEqual({ ok: true, repeat: undefined });
    expect(parseRepeat('{"every":60000,"limit":3}')).toEqual({
      ok: true,
      repeat: { every: 60000, limit: 3 },
    });
    const pattern = parseRepeat('{"pattern":"0 9 * * *"}');
    expect(pattern.ok).toBe(false);
    if (!pattern.ok) expect(pattern.msg).toContain('unsafe in bunqueue v2.8.59');
    expect(parseRepeat('{"every":60000,"pattern":"0 9 * * *"}').ok).toBe(false);
    expect(parseRepeat('{"every":60000,"startDate":123}').ok).toBe(false);
    expect(parseRepeat('[]').ok).toBe(false);
    expect(parseRepeat('{"every":0}').ok).toBe(false);
    expect(parseRepeat('{"every":1.5}').ok).toBe(false);
    expect(parseRepeat('{"every":31536000001}').ok).toBe(false);
    expect(parseRepeat('{"every":1000,"limit":0}').ok).toBe(false);
    expect(parseRepeat('{"every":1000,"limit":1.5}').ok).toBe(false);
    expect(parseRepeat('{}').ok).toBe(false);
  });

  test('numeric options match the exact PUSH bounds and reject unsafe coercions', () => {
    expect(
      parseAddJobNumbers({
        priority: '-1000000',
        delay: '31536000000',
        maxAttempts: '1000',
        backoff: '86400000',
        timeout: '0',
      })
    ).toEqual({
      ok: true,
      options: {
        priority: -1_000_000,
        delay: 31_536_000_000,
        maxAttempts: 1000,
        backoff: 86_400_000,
        timeout: 0,
      },
    });
    expect(
      parseAddJobNumbers({ priority: '1.5', delay: '', maxAttempts: '', backoff: '', timeout: '' })
        .ok
    ).toBe(false);
    expect(
      parseAddJobNumbers({ priority: '', delay: '-1', maxAttempts: '', backoff: '', timeout: '' })
        .ok
    ).toBe(false);
    expect(
      parseAddJobNumbers({ priority: '', delay: '', maxAttempts: '0', backoff: '', timeout: '' }).ok
    ).toBe(false);
    expect(
      parseAddJobNumbers({
        priority: '',
        delay: '',
        maxAttempts: '',
        backoff: '',
        timeout: '9007199254740992',
      }).ok
    ).toBe(false);
  });

  test('queue names follow the v2.8.55 grammar', () => {
    expect(queueNameError('orders:eu-west.1_retry')).toBeNull();
    expect(queueNameError('')).toContain('Choose');
    expect(queueNameError('orders/eu')).toContain('only');
    expect(queueNameError('q'.repeat(257))).toContain('256');
    // The broker grammar admits dots, but these two exact names cannot be
    // managed over HTTP: WHATWG URL parsing removes the path segment.
    expect(queueNameError('.')).toContain('path traversal segment');
    expect(queueNameError('..')).toContain('path traversal segment');
    expect(queueNameError('orders..archive')).toBeNull();
  });
});
