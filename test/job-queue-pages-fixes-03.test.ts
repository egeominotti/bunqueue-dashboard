import {
  clickText,
  createElement,
  describe,
  expect,
  installTestHooks,
  JobInspector,
  json,
  MemoryRouter,
  render,
  settle,
  test,
} from './job-queue-pages-fixes.helpers';

installTestHooks();

describe('JobInspector — a fetch failure is never rendered as a fact', () => {
  const job = { id: 'j1', queue: 'q', state: 'completed', maxAttempts: 1 };

  test('uses Bunqueue 2.8.59 embedded returnvalue without a second result request', async () => {
    let resultGets = 0;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/result')) {
        resultGets += 1;
        return Promise.resolve(json({ ok: true, id: 'j1', result: 'legacy' }));
      }
      if (url.endsWith('/logs')) {
        return Promise.resolve(json({ ok: true, data: { logs: [], count: 0 } }));
      }
      return Promise.resolve(
        json({ ok: true, job: { ...job, name: 'render-report', returnvalue: { done: true } } })
      );
    }) as typeof fetch;

    const { container, unmount } = render(
      createElement(MemoryRouter, { initialEntries: ['/job?id=j1'] }, createElement(JobInspector))
    );
    await settle(10);
    expect(resultGets).toBe(0);
    expect(container.textContent).toContain('render-report');
    expect(container.textContent).toContain('done');
    unmount();
  });

  test('a failed result fetch says so instead of "No result stored"', async () => {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/result')) return Promise.resolve(json({ ok: false, error: 'bad' }, 502));
      return Promise.resolve(json({ ok: true, job }));
    }) as typeof fetch;

    const { container, unmount } = render(
      createElement(MemoryRouter, { initialEntries: ['/job?id=j1'] }, createElement(JobInspector))
    );
    await settle(10);
    const text = container.textContent ?? '';
    expect(text).toContain("Couldn't load result");
    expect(text).not.toContain('No result stored for this job.');
    unmount();
  });

  test('a malformed successful result envelope is reported instead of treated as empty', async () => {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/result')) return Promise.resolve(json({ ok: true }));
      return Promise.resolve(json({ ok: true, job }));
    }) as typeof fetch;

    const { container, unmount } = render(
      createElement(MemoryRouter, { initialEntries: ['/job?id=j1'] }, createElement(JobInspector))
    );
    await settle(10);
    const text = container.textContent ?? '';
    expect(text).toContain("Couldn't load result");
    expect(text).toContain('Invalid job result response');
    expect(text).not.toContain('No result stored for this job.');
    unmount();
  });

  test('a mutation that succeeded is not reported as failed when the reload errors', async () => {
    let jobGets = 0;
    const delayedJob = { ...job, state: 'delayed' };
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? 'GET') !== 'GET') return Promise.resolve(json({ ok: true }));
      if (url.endsWith('/result')) return Promise.resolve(json({ ok: true, result: 1 }));
      jobGets += 1;
      // The post-action read-back (2nd GET) hits a proxy blip.
      if (jobGets > 1) return Promise.resolve(json({ ok: false, error: 'Failed to fetch' }, 502));
      return Promise.resolve(json({ ok: true, job: delayedJob }));
    }) as typeof fetch;

    const { container, unmount } = render(
      createElement(MemoryRouter, { initialEntries: ['/job?id=j1'] }, createElement(JobInspector))
    );
    await settle(10);
    clickText(container, 'Promote (run now)');
    await settle(10);
    const text = container.textContent ?? '';
    // Pre-fix the red reload error REPLACED the success line, so the operator
    // re-ran an action the server had already accepted.
    expect(text).toContain('Promote ✓');
    expect(text).toContain("couldn't reload");
    unmount();
  });
});
