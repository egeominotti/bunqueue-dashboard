import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { bulkDroppedFields, createdSummary, resolveBackoff } from '../src/pages/control/AddJob';
import {
  asNum,
  asStr,
  bulkSummary,
  coerceBody,
  parseInput,
  specWouldDropValues,
} from '../src/pages/control/BulkAddJobs';
import {
  useClampedPage as useClampedPageCron,
  useTransientFlag,
} from '../src/pages/control/CronManager';
import {
  buildWebhookBody,
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

  test('advanced fields the bulk route ignores are named', () => {
    expect(bulkDroppedFields({ data: {} })).toEqual([]);
    expect(
      bulkDroppedFields({ data: {}, tags: ['a'], groupId: 'g', dependsOn: ['x'], uniqueKey: 'u' })
    ).toEqual(['Tags', 'Group ID', 'Depends on', 'Unique key']);
    // Empty advanced values must not trip the guard.
    expect(bulkDroppedFields({ data: {}, tags: [], dependsOn: [] })).toEqual([]);
  });

  test('a created/submitted shortfall is never reported as success', () => {
    expect(createdSummary(50, 50)).toEqual({ ok: true, msg: 'Created 50 jobs' });
    const short = createdSummary(497, 500);
    expect(short.ok).toBe(false);
    expect(short.msg).toContain('497 of 500');
    expect(short.msg).toContain('3 were not created');
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
    // raw-shaped items (no `data` key) are not spec items.
    expect(specWouldDropValues([{ priority: 'high' }])).toBe(false);
  });

  test('bulk import compares created against submitted', () => {
    expect(bulkSummary(2, 2, 'orders')).toEqual({ ok: true, msg: 'Created 2 jobs in orders' });
    const short = bulkSummary(497, 500, 'orders');
    expect(short.ok).toBe(false);
    expect(short.msg).toContain('497 of 500');
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
    expect(src).toContain('{ name: name.trim(), queue: queue.trim(), data }');
    expect(src).not.toContain('{ name, queue, data }');
  });
});
