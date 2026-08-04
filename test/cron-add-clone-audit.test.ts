import {
  act,
  assertCronNameAvailable,
  buildCronBody,
  CronManager,
  createElement,
  cronValues,
  describe,
  existingCronNameError,
  expect,
  installTestHooks,
  json,
  MAX_JOB_DATA_CHARS,
  render,
  setInput,
  settle,
  test,
} from './cron-add-clone-audit.helpers';

installTestHooks();

describe('CronManager v2.8.55 contract', () => {
  test('transports shortcuts and six-field expressions even when local preview cannot parse them', () => {
    const shortcut = buildCronBody(cronValues('  @hourly  '));
    expect(shortcut.ok).toBe(true);
    if (shortcut.ok) expect(shortcut.body.schedule).toBe('@hourly');

    const sixFields = buildCronBody(cronValues('*/10 * * * * *'));
    expect(sixFields.ok).toBe(true);
    if (sixFields.ok) expect(sixFields.body.schedule).toBe('*/10 * * * * *');

    // The local helper is a preview only; the server's Croner parser is the
    // authoritative validator for every non-empty expression.
    expect(buildCronBody(cronValues('')).ok).toBe(false);
  });

  test('refuses cron names that URL parsing would retarget or cannot encode', () => {
    const dot = buildCronBody({ ...cronValues('@hourly'), name: '.' });
    expect(dot.ok).toBe(false);
    if (!dot.ok) expect(dot.msg).toContain('path traversal segment');
    expect(buildCronBody({ ...cronValues('@hourly'), name: '..' }).ok).toBe(false);
    expect(buildCronBody({ ...cronValues('@hourly'), name: '\ud800' }).ok).toBe(false);
  });

  test('rejects oversized UTF-8 cron data before JSON.parse', () => {
    const originalParse = JSON.parse;
    let parseCalls = 0;
    Object.defineProperty(JSON, 'parse', {
      configurable: true,
      writable: true,
      value: ((...args: Parameters<typeof JSON.parse>) => {
        parseCalls += 1;
        return originalParse(...args);
      }) as typeof JSON.parse,
    });

    try {
      const utf8Oversize = `"${'💥'.repeat(MAX_JOB_DATA_CHARS / 4 + 1)}"`;
      expect(utf8Oversize.length).toBeLessThan(MAX_JOB_DATA_CHARS);
      const result = buildCronBody({
        ...cronValues('@hourly'),
        dataText: utf8Oversize,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.msg).toContain('too large');
      expect(parseCalls).toBe(0);
    } finally {
      Object.defineProperty(JSON, 'parse', {
        configurable: true,
        writable: true,
        value: originalParse,
      });
    }
  });

  test('fails closed when an upsert name is known or cannot be checked', () => {
    const names = new Set(['hourly-report']);
    expect(existingCronNameError(' hourly-report ', names)).toContain('does not return complete');
    expect(existingCronNameError('new-report', names)).toBeNull();

    expect(() =>
      assertCronNameAvailable({ ok: true, crons: [{ name: 'hourly-report' }] }, 'hourly-report')
    ).toThrow('already exists');
    expect(() => assertCronNameAvailable({ ok: true, crons: [] }, 'hourly-report')).not.toThrow();
    expect(() => assertCronNameAvailable({ ok: true }, 'hourly-report')).toThrow(
      'creation was not attempted'
    );
  });

  test('an existing name disables create and cannot submit an update', async () => {
    let posts = 0;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/crons') && (init?.method ?? 'GET') === 'GET') {
        return Promise.resolve(
          json({
            ok: true,
            crons: [
              {
                name: 'hourly-report',
                queue: 'reports',
                schedule: '@hourly',
                nextRun: Date.now() + 60_000,
                executions: 0,
              },
            ],
          })
        );
      }
      if (url.endsWith('/crons') && init?.method === 'POST') {
        posts += 1;
        return Promise.resolve(json({ ok: true }));
      }
      return Promise.resolve(json({ ok: false, error: 'unexpected request' }, 500));
    }) as typeof fetch;

    const view = render(createElement(CronManager));
    await settle(10);
    setInput(view.host.querySelector<HTMLInputElement>('[name="cron-name"]')!, 'hourly-report');
    setInput(view.host.querySelector<HTMLInputElement>('[name="cron-queue"]')!, 'reports');
    setInput(view.host.querySelector<HTMLInputElement>('[name="cron-expression"]')!, '@hourly');
    await settle(1);

    const create = [...view.host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Name already exists')
    );
    if (!create) throw new Error(`Create conflict state missing: ${view.host.textContent}`);
    expect(create?.disabled).toBe(true);
    expect(view.host.textContent).toContain('Delete it explicitly');
    act(() =>
      view.host
        .querySelector('form')!
        .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
    );
    await settle(2);
    expect(posts).toBe(0);
    view.unmount();
  });
});
