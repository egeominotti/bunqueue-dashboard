import {
  asNum,
  asStr,
  coerceBody,
  describe,
  expect,
  parseBulkDefaults,
  parseDedup,
  parseInput,
  specWouldDropValues,
  test,
} from './mutating-forms-fixes.helpers';

describe('BulkAddJobs', () => {
  test('NDJSON parse errors point at the textarea line, not the trimmed line', () => {
    const r = parseInput('\n\n{"data":1}\n{data:2}\n');
    expect(r.items).toEqual([]);
    expect(r.error).toStartWith('Line 4:');
  });

  test('leading blank lines do not change the parsed items', () => {
    expect(parseInput('\n\n{"data":1}\n{"data":2}\n').items).toEqual([{ data: 1 }, { data: 2 }]);
  });

  test('spec mode keeps string-typed numbers and numeric ids', () => {
    expect(asNum('5')).toBe(5);
    expect(asNum(' 7 ')).toBe(7);
    expect(asNum('')).toBeUndefined();
    expect(asNum('  ')).toBeUndefined();
    expect(asNum('abc')).toBeUndefined();
    expect(asStr(1001)).toBe('1001');
    expect(asStr('')).toBeUndefined();

    const body = coerceBody(
      { data: { order: 1 }, jobId: 'ord-1', priority: '5', maxAttempts: '7' },
      { priority: 9 },
      'spec'
    );
    expect(body.priority).toBe(5);
    expect(body.maxAttempts).toBe(7);
    expect(body.jobId).toBe('ord-1');
    expect(coerceBody({ data: {}, jobId: 1001 }, {}, 'spec').jobId).toBe('1001');
  });

  test('spec mode preserves Bunqueue 2.8.59 first-class job names', () => {
    expect(coerceBody({ name: 'send-email', data: { userId: 7 } }, {}, 'spec')).toMatchObject({
      name: 'send-email',
      data: { userId: 7 },
    });
  });

  test('an option whose value type cannot be sent raises a warning', () => {
    expect(specWouldDropValues([{ data: {}, removeOnComplete: 'yes' }])).toBe(true);
    expect(specWouldDropValues([{ data: {}, priority: 'high' }])).toBe(true);
    // Coercible / correctly typed values must not warn.
    expect(specWouldDropValues([{ data: {}, priority: '5', jobId: 7, durable: true }])).toBe(false);
    expect(specWouldDropValues([{ data: {} }])).toBe(false);
    expect(
      specWouldDropValues([
        {
          data: {},
          tags: ['mail', 'urgent'],
          dependsOn: ['parent-1'],
          backoff: { type: 'exponential', delay: 500 },
          repeat: { every: 1000 },
          dedup: { ttl: 5000, extend: true },
        },
      ])
    ).toBe(false);
    // raw-shaped items (no `data` key) are not spec items.
    expect(specWouldDropValues([{ priority: 'high' }])).toBe(false);
  });

  test('spec mode preserves the reliable bulk JobInput options from v2.8.55', () => {
    expect(
      coerceBody(
        {
          data: { order: 1 },
          customId: 99,
          tags: ['orders'],
          groupId: 'tenant-a',
          dependsOn: [1, 'p2'],
          backoff: { type: 'exponential', delay: '250' },
          repeat: { every: 1000 },
          dedup: { ttl: 5000, replace: true },
          stallTimeout: '30000',
          stackTraceLimit: '25',
          timestamp: '123456789',
        },
        {},
        'spec'
      )
    ).toMatchObject({
      jobId: '99',
      tags: ['orders'],
      groupId: 'tenant-a',
      dependsOn: ['1', 'p2'],
      backoff: { type: 'exponential', delay: 250 },
      repeat: { every: 1000 },
      dedup: { ttl: 5000, replace: true },
      stallTimeout: 30000,
      stackTraceLimit: 25,
      timestamp: 123456789,
    });
  });

  test('bulk defaults reject values the v2.8.55 server would reject', () => {
    expect(parseBulkDefaults({ priority: '', maxAttempts: '', backoff: '', timeout: '' })).toEqual({
      ok: true,
      defaults: {},
    });
    expect(
      parseBulkDefaults({
        priority: '1000000',
        maxAttempts: '1',
        backoff: '0',
        timeout: '86400000',
      }).ok
    ).toBe(true);
    expect(
      parseBulkDefaults({ priority: '1.5', maxAttempts: '', backoff: '', timeout: '' }).ok
    ).toBe(false);
    expect(parseBulkDefaults({ priority: '', maxAttempts: '0', backoff: '', timeout: '' }).ok).toBe(
      false
    );
  });

  test('dedup is sanitized and ambiguous combinations are blocked', () => {
    expect(parseDedup({ ttl: 5000, replace: true })).toEqual({
      ok: true,
      dedup: { ttl: 5000, replace: true },
    });
    expect(parseDedup({ ttl: 5000, typo: true }).ok).toBe(false);
    expect(parseDedup({ extend: true }).ok).toBe(false);
    expect(parseDedup({ ttl: 5000, extend: true, replace: true }).ok).toBe(false);
    expect(parseDedup({ ttl: 1.5 }).ok).toBe(false);
  });
});
