import {
  act,
  assertCronCreateResponse,
  assertCronDeleteResponse,
  buildCronBody,
  buildWebhookBody,
  cronValues,
  describe,
  displayWebhookUrl,
  expect,
  renderHook,
  settle,
  test,
  useClampedPageCron,
  useClampedPageHooks,
  useTransientFlag,
} from './mutating-forms-fixes.helpers';

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
