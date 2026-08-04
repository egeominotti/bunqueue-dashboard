import {
  act,
  CronManager,
  createElement,
  deferred,
  describe,
  expect,
  installTestHooks,
  json,
  render,
  setInput,
  settle,
  test,
  useConnectionStore,
} from './cron-add-clone-audit.helpers';

installTestHooks();

describe('CronManager v2.8.55 contract', () => {
  test('a server retarget during the name preflight never redirects the upsert', async () => {
    const preflight = deferred<Response>();
    let gets = 0;
    let posts = 0;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/crons') && (init?.method ?? 'GET') === 'GET') {
        gets += 1;
        if (gets === 2) return preflight.promise;
        return Promise.resolve(json({ ok: true, crons: [] }));
      }
      if (url.endsWith('/crons') && init?.method === 'POST') {
        posts += 1;
        return Promise.resolve(json({ ok: true, cron: { name: 'new-report', queue: 'reports' } }));
      }
      return Promise.resolve(json({ ok: false, error: 'unexpected request' }, 500));
    }) as typeof fetch;

    const view = render(createElement(CronManager));
    await settle(10);
    setInput(view.host.querySelector<HTMLInputElement>('[name="cron-name"]')!, 'new-report');
    setInput(view.host.querySelector<HTMLInputElement>('[name="cron-queue"]')!, 'reports');
    setInput(view.host.querySelector<HTMLInputElement>('[name="cron-expression"]')!, '@hourly');
    act(() =>
      view.host
        .querySelector('form')!
        .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
    );
    await settle(1);
    expect(gets).toBe(2);

    act(() => useConnectionStore.setState({ baseUrl: 'http://other-server.test' }));
    preflight.resolve(json({ ok: true, crons: [] }));
    await settle(10);
    expect(posts).toBe(0);
    view.unmount();
  });
});
