import {
  buttonByText,
  clickSameTick,
  createElement,
  deferred,
  describe,
  expect,
  installTestHooks,
  JobsPro,
  json,
  MemoryRouter,
  queueSummary,
  render,
  settle,
  test,
  useConnectionStore,
  act,
} from './server-action-pages.helpers';

installTestHooks();

describe('Jobs CSV export', () => {
  test('exports every matching job from a queue, including jobs beyond the current page', async () => {
    const jobs = Array.from({ length: 235 }, (_, index) => ({
      id: `job-${String(index).padStart(3, '0')}`,
      queue: 'orders',
      name: 'invoice',
      state: 'waiting',
      createdAt: 1_700_000_000_000,
    }));
    const exportOffsets: number[] = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/queues/summary')) {
        return Promise.resolve(json([queueSummary('orders')]));
      }
      if (url.pathname.endsWith('/stats')) return Promise.resolve(json({ ok: false }, 503));
      if (url.pathname.endsWith('/queues/orders/jobs/list')) {
        const offset = Number(url.searchParams.get('offset') ?? 0);
        const limit = Number(url.searchParams.get('limit') ?? 25);
        if (limit === 100) exportOffsets.push(offset);
        return Promise.resolve(json({ ok: true, jobs: jobs.slice(offset, offset + limit) }));
      }
      return Promise.resolve(json({ ok: false, error: 'Unexpected request' }, 500));
    }) as typeof fetch;

    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    const originalClick = window.HTMLAnchorElement.prototype.click;
    const files: Blob[] = [];
    URL.createObjectURL = ((blob: Blob) => {
      files.push(blob);
      return 'blob:jobs-test';
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = () => {};
    window.HTMLAnchorElement.prototype.click = () => {};
    const view = render(
      createElement(
        MemoryRouter,
        { initialEntries: ['/jobs?queue=orders'] },
        createElement(JobsPro)
      )
    );
    try {
      await settle(40);
      expect(view.host.querySelectorAll('tbody tr')).toHaveLength(25);
      const exportAll = [...view.host.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === 'Export all matching CSV'
      );
      expect(exportAll).toBeDefined();
      clickSameTick(exportAll as HTMLButtonElement, 1);
      await settle(40);
      expect(files).toHaveLength(1);
      const csv = await files[0].text();
      expect(csv.split('\n')).toHaveLength(236);
      expect(csv).toContain('job-234');
      expect(exportOffsets).toEqual([0, 100, 200]);
      expect(buttonByText(view.host, 'Export page CSV')).toBeDefined();
    } finally {
      view.unmount();
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
      window.HTMLAnchorElement.prototype.click = originalClick;
    }
  });

  test('does not download a stale export after the active server changes', async () => {
    const pending = deferred<Response>();
    const jobs = [{ id: 'job-a', queue: 'orders', name: 'invoice', state: 'waiting' }];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/queues/summary')) {
        return Promise.resolve(json([queueSummary('orders')]));
      }
      if (url.pathname.endsWith('/stats')) return Promise.resolve(json({ ok: false }, 503));
      if (url.pathname.endsWith('/queues/orders/jobs/list')) {
        if (url.host === 'server-a.test' && url.searchParams.get('limit') === '100') {
          return pending.promise;
        }
        return Promise.resolve(json({ ok: true, jobs }));
      }
      return Promise.resolve(json({ ok: false, error: 'Unexpected request' }, 500));
    }) as typeof fetch;

    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    const originalClick = window.HTMLAnchorElement.prototype.click;
    const files: Blob[] = [];
    URL.createObjectURL = ((blob: Blob) => {
      files.push(blob);
      return 'blob:jobs-test';
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = () => {};
    window.HTMLAnchorElement.prototype.click = () => {};
    const view = render(
      createElement(
        MemoryRouter,
        { initialEntries: ['/jobs?queue=orders'] },
        createElement(JobsPro)
      )
    );
    try {
      await settle(40);
      const exportAll = [...view.host.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === 'Export all matching CSV'
      );
      expect(exportAll).toBeDefined();
      clickSameTick(exportAll as HTMLButtonElement, 1);
      await settle(10);
      act(() => useConnectionStore.setState({ baseUrl: 'http://server-b.test' }));
      pending.resolve(json({ ok: true, jobs }));
      await settle(40);
      expect(files).toHaveLength(0);
    } finally {
      view.unmount();
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
      window.HTMLAnchorElement.prototype.click = originalClick;
    }
  });
});
