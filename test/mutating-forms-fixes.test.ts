import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { act } from 'react';
import {
  acceptedBulkIds,
  acceptedJobId,
  createdSummary,
  parseAddJobNumbers,
  parseRepeat,
  queueNameError,
  resolveBackoff,
} from '../src/pages/control/AddJob';
import {
  asNum,
  asStr,
  bulkSummary,
  coerceBody,
  parseBulkDefaults,
  parseDedup,
  parseInput,
  specWouldDropValues,
  validateBulkItems,
} from '../src/pages/control/BulkAddJobs';
import {
  assertCronCreateResponse,
  assertCronDeleteResponse,
  buildCronBody,
  type CronFormValues,
  useClampedPage as useClampedPageCron,
  useTransientFlag,
} from '../src/pages/control/CronManager';
import {
  buildWebhookBody,
  displayWebhookUrl,
  useClampedPage as useClampedPageHooks,
} from '../src/pages/control/Webhooks';
import { renderHook, settle } from './domSetup';

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
    if (!pattern.ok) expect(pattern.msg).toContain('unsafe in bunqueue v2.8.57');
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

  test('spec validation blocks silent option loss and invalid relationships', () => {
    expect(validateBulkItems([{ data: {}, unexpected: true }], {}, 'spec').ok).toBe(false);
    expect(validateBulkItems([{ data: {}, priority: 1.5 }], {}, 'spec').ok).toBe(false);
    expect(validateBulkItems([{ data: {}, repeat: { pattern: '0 9 * * *' } }], {}, 'spec').ok).toBe(
      false
    );
    expect(
      validateBulkItems(
        [{ data: {}, uniqueKey: 'u', dedup: { ttl: 1000, typo: true } }],
        {},
        'spec'
      ).ok
    ).toBe(false);
    for (const unsafe of [
      'parentId',
      'childrenIds',
      'failParentOnFailure',
      'removeDependencyOnFailure',
      'continueParentOnFailure',
      'ignoreDependencyOnFailure',
      'keepLogs',
      'sizeLimit',
      'debounceId',
      'debounceTtl',
    ]) {
      expect(validateBulkItems([{ data: {}, [unsafe]: true }], {}, 'spec').ok).toBe(false);
    }
    expect(validateBulkItems([{ data: {}, jobId: 'a', customId: 'b' }], {}, 'spec').ok).toBe(false);
    expect(
      validateBulkItems(
        [
          { data: {}, jobId: 'a', dependsOn: ['b'] },
          { data: {}, jobId: 'b', dependsOn: ['a'] },
        ],
        {},
        'spec'
      ).ok
    ).toBe(false);
    expect(
      validateBulkItems(
        [
          { data: {}, jobId: 'duplicate' },
          { data: {}, customId: 'duplicate' },
        ],
        {},
        'spec'
      ).ok
    ).toBe(false);
  });

  test('valid full specs survive validation as the exact request bodies', () => {
    const parsed = validateBulkItems(
      [
        {
          data: { order: 1 },
          priority: '5',
          customId: 99,
          uniqueKey: 'order-99',
          repeat: { every: 1000, limit: 2 },
          dedup: { ttl: 5000, replace: true },
          dependsOn: ['external-parent'],
          stallTimeout: 30_000,
          stackTraceLimit: 25,
          timestamp: 123456789,
        },
      ],
      {},
      'spec'
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.bodies[0]).toMatchObject({
        data: { order: 1 },
        priority: 5,
        jobId: '99',
        uniqueKey: 'order-99',
        repeat: { every: 1000, limit: 2 },
        dedup: { ttl: 5000, replace: true },
        dependsOn: ['external-parent'],
        stallTimeout: 30_000,
        stackTraceLimit: 25,
        timestamp: 123456789,
      });
    }
  });

  test('bulk import describes accepted submissions and distinct ids', () => {
    expect(bulkSummary(2, 2, 'orders')).toEqual({
      ok: true,
      msg: 'Accepted 2 job submissions in orders; server returned 2 distinct job IDs (deduplication may reuse existing jobs)',
    });
    const short = bulkSummary(497, 500, 'orders');
    expect(short.ok).toBe(true);
    expect(short.msg).toContain('Accepted 500 job submissions');
    expect(short.msg).toContain('497 distinct job IDs');
    expect(short.msg).not.toContain('Created');
  });
});

const cronValues = (overrides: Partial<CronFormValues> = {}): CronFormValues => ({
  name: ' daily-report ',
  queue: ' reports ',
  mode: 'cron',
  schedule: '0 9 * * *',
  every: '',
  dataText: '{"report":true}',
  timezone: 'Europe/Rome',
  priority: '-2',
  preventOverlap: true,
  skipIfNoWorker: false,
  maxLimit: '25',
  immediately: false,
  skipMissedOnRestart: true,
  uniqueKey: ' daily-report-key ',
  dedupTtl: '60000',
  dedupExtend: false,
  dedupReplace: true,
  jobMaxAttempts: '3',
  jobBackoff: '1000',
  jobTimeout: '30000',
  jobDelay: '0',
  jobStallTimeout: '5000',
  jobRemoveOnComplete: true,
  jobRemoveOnFail: false,
  ...overrides,
});

describe('CronManager request validation', () => {
  test('requires the exact v2.8.55 create/delete success envelopes', () => {
    const expected = buildCronBody(cronValues());
    expect(expected.ok).toBe(true);
    if (!expected.ok) return;
    expect(() =>
      assertCronCreateResponse(
        { ok: true, cron: { name: expected.body.name, queue: expected.body.queue } },
        expected.body
      )
    ).not.toThrow();
    expect(() => assertCronCreateResponse({ ok: true }, expected.body)).toThrow(
      'malformed success response'
    );
    expect(() => assertCronDeleteResponse({ ok: true })).not.toThrow();
    expect(() => assertCronDeleteResponse({})).toThrow('malformed success response');
  });

  test('trims identifiers and preserves every supported v2.8.55 option', () => {
    const parsed = buildCronBody(cronValues(), Date.UTC(2026, 0, 1));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.body).toEqual({
        name: 'daily-report',
        jobName: 'default',
        queue: 'reports',
        data: { report: true },
        preventOverlap: true,
        skipIfNoWorker: false,
        immediately: false,
        skipMissedOnRestart: true,
        schedule: '0 9 * * *',
        timezone: 'Europe/Rome',
        priority: -2,
        maxLimit: 25,
        uniqueKey: 'daily-report-key',
        dedup: { ttl: 60000, replace: true },
        jobOptions: {
          maxAttempts: 3,
          backoff: 1000,
          timeout: 30000,
          delay: 0,
          stallTimeout: 5000,
          removeOnComplete: true,
        },
      });
    }
  });

  test('interval schedules reject timezone and out-of-range intervals', () => {
    expect(buildCronBody(cronValues({ mode: 'every', every: '60000', timezone: '' })).ok).toBe(
      true
    );
    expect(buildCronBody(cronValues({ mode: 'every', every: '60000' })).ok).toBe(false);
    expect(
      buildCronBody(cronValues({ mode: 'every', every: '31536000001', timezone: '' })).ok
    ).toBe(false);
    expect(buildCronBody(cronValues({ mode: 'every', every: '1.5', timezone: '' })).ok).toBe(false);
  });

  test('cron syntax is server-authoritative while local options remain guarded', () => {
    const shortcut = buildCronBody(cronValues({ schedule: '@hourly' }));
    expect(shortcut.ok).toBe(true);
    if (shortcut.ok) expect(shortcut.body.schedule).toBe('@hourly');
    const sixFields = buildCronBody(cronValues({ schedule: '*/10 * * * * *' }));
    expect(sixFields.ok).toBe(true);
    if (sixFields.ok) expect(sixFields.body.schedule).toBe('*/10 * * * * *');
    expect(buildCronBody(cronValues({ schedule: '   ' })).ok).toBe(false);
    expect(buildCronBody(cronValues({ timezone: 'Mars/Olympus' })).ok).toBe(false);
    expect(buildCronBody(cronValues({ priority: '1.5' })).ok).toBe(false);
    expect(buildCronBody(cronValues({ jobMaxAttempts: '0' })).ok).toBe(false);
    expect(buildCronBody(cronValues({ dedupExtend: true, dedupReplace: true })).ok).toBe(false);
    expect(
      buildCronBody(
        cronValues({ uniqueKey: '', preventOverlap: false, dedupTtl: '1000', dedupReplace: false })
      ).ok
    ).toBe(false);
  });
});

describe('Webhooks', () => {
  test('the registered URL is the validated (trimmed) string', () => {
    const r = buildWebhookBody('  https://example.com/hook \n', ['job.failed'], ' q ', ' s ');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.body.url).toBe('https://example.com/hook');
      expect(r.body.queue).toBe('q');
      expect(r.body.secret).toBe('s');
    }
  });

  test('a non-http URL or no event is refused', () => {
    expect(buildWebhookBody('example.com/hook', ['job.failed'], '', '').ok).toBe(false);
    expect(buildWebhookBody('ftp://example.com', ['job.failed'], '', '').ok).toBe(false);
    expect(buildWebhookBody('https://example.com', [], '', '').ok).toBe(false);
    expect(buildWebhookBody('https://user:password@example.com', ['job.failed'], '', '').ok).toBe(
      false
    );
    expect(buildWebhookBody('https://example.com', ['job.failed'], 'bad queue', '').ok).toBe(false);
    expect(displayWebhookUrl('https://user:password@example.com/hook')).not.toContain('password');
  });
});

// The clamp hook is duplicated (one per page, additive-only), so exercise both.
describe.each([
  ['CronManager', useClampedPageCron],
  ['Webhooks', useClampedPageHooks],
])('%s useClampedPage', (_name, useClampedPage) => {
  test('a list that shrinks then regrows does not jump the view forward', async () => {
    const h = renderHook((pageCount: number) => useClampedPage(pageCount), 2);
    act(() => h.result.current[1](1));
    expect(h.result.current[0]).toBe(1);
    // The tail entry is deleted: one page left, so the state itself must clamp.
    h.rerender(1);
    await settle(0);
    expect(h.result.current[0]).toBe(0);
    // A new entry brings page 2 back — without a state clamp the view would jump.
    h.rerender(2);
    await settle(0);
    expect(h.result.current[0]).toBe(0);
    h.unmount();
  });
});

describe('CronManager useTransientFlag', () => {
  test('a second fire gets its own full window', async () => {
    const h = renderHook(() => useTransientFlag(60));
    act(() => h.result.current.fire());
    expect(h.result.current.on).toBe(true);
    await settle(40);
    act(() => h.result.current.fire());
    // The first fire's timer would expire around here; it must not clear this one.
    await settle(40);
    expect(h.result.current.on).toBe(true);
    await settle(40);
    expect(h.result.current.on).toBe(false);
    h.unmount();
  });

  test('reset clears immediately and unmount kills the timer', async () => {
    const h = renderHook(() => useTransientFlag(20));
    act(() => h.result.current.fire());
    act(() => h.result.current.reset());
    expect(h.result.current.on).toBe(false);
    act(() => h.result.current.fire());
    h.unmount();
    await settle(40); // no "update on unmounted component" fallout
  });
});

// These forms cannot be driven through the happy-dom harness (React's onChange
// never fires there), so guard the call sites at the source level: the value
// that passes validation must be the value handed to the API.
describe('submit the validated value', () => {
  const read = (p: string) =>
    readFileSync(new URL(`../src/pages/control/${p}`, import.meta.url), 'utf8');

  test('AddJob enqueues against the trimmed queue', () => {
    const src = read('AddJob.tsx');
    expect(src).toContain('bq.addJob(target,');
    expect(src).not.toContain('bq.addJob(queue,');
    expect(src).not.toContain('bq.addJobsBulk(\n          queue,');
  });

  test('BulkAddJobs imports against the trimmed queue', () => {
    const src = read('BulkAddJobs.tsx');
    expect(src).toContain('bq.addJobsBulk(target,');
    expect(src).not.toContain('bq.addJobsBulk(queue,');
  });

  test('CronManager persists the trimmed name and queue', () => {
    const src = read('CronManager.tsx');
    expect(src).toContain('const built = buildCronBody({');
    expect(src).toContain('const body = built.body;');
    expect(src).not.toContain('{ name, queue, data }');
  });
});
