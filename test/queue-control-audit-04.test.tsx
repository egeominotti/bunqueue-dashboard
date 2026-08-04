import {
  act,
  bq,
  click,
  concurrencyArgs,
  createElement,
  describe,
  expect,
  findButton,
  installTestHooks,
  json,
  LifecycleCard,
  promoteConfirmation,
  type RunAction,
  rateLimitArgs,
  render,
  test,
} from './queue-control-audit.helpers';

installTestHooks();

describe('Queue lifecycle request scope and destructive confirmations', () => {
  test('flow-destructive queue operations fail closed without invoking run', () => {
    let calls = 0;
    const run: RunAction = () => {
      calls += 1;
    };
    const { host } = render(
      createElement(LifecycleCard, { queue: 'orders', paused: false, busy: false, run })
    );
    const clean = findButton(host, 'Clean');
    const drain = findButton(host, 'Drain');
    expect(clean.disabled).toBe(true);
    expect(drain.disabled).toBe(true);
    expect(clean.title).toContain('reverse flow dependencies');
    expect(drain.title).toBe(clean.title);
    expect((host.querySelector('[name="clean-state"]') as HTMLSelectElement).disabled).toBe(true);
    act(() => {
      clean.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      drain.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    expect(calls).toBe(0);
  });

  test('completed requeue is disabled while promotion still names its full effect and target', () => {
    let confirmation = '';
    let calls = 0;
    const run: RunAction = (_label, _fn, nextConfirmation) => {
      calls += 1;
      confirmation = nextConfirmation ?? '';
    };
    const { host } = render(
      createElement(LifecycleCard, { queue: 'orders', paused: false, busy: false, run })
    );

    const requeue = findButton(host, 'Requeue completed');
    expect(requeue.disabled).toBe(true);
    act(() => requeue.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    expect(calls).toBe(0);
    expect(confirmation).toBe('');

    click(host, 'Promote delayed');
    expect(calls).toBe(1);
    expect(confirmation).toContain('every delayed job');
    expect(promoteConfirmation('orders', 3)).toContain('up to 3 delayed jobs');
  });

  test('rate-limit and concurrency controls send exact v2.8.55 bodies and methods', async () => {
    const calls: Array<{ path: string; method: string; body: unknown }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        path: new URL(String(input)).pathname,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return json({ ok: true });
    }) as typeof fetch;

    const rate = rateLimitArgs('10', '60000', '3600000');
    const concurrency = concurrencyArgs('4');
    expect(rate.valid).toBe(true);
    expect(concurrency.valid).toBe(true);
    await bq.setRateLimit('orders', rate.limit, rate.duration, rate.ttl);
    await bq.setConcurrency('orders', concurrency.value);
    await bq.clearRateLimit('orders');
    await bq.clearConcurrency('orders');

    expect(calls).toEqual([
      {
        path: '/queues/orders/rate-limit',
        method: 'PUT',
        body: { limit: 10, duration: 60_000, ttl: 3_600_000 },
      },
      {
        path: '/queues/orders/concurrency',
        method: 'PUT',
        body: { concurrency: 4 },
      },
      { path: '/queues/orders/rate-limit', method: 'DELETE', body: undefined },
      { path: '/queues/orders/concurrency', method: 'DELETE', body: undefined },
    ]);
  });
});
