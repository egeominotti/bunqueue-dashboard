import {
  buttonByText,
  clickSameTick,
  createElement,
  describe,
  expect,
  installTestHooks,
  json,
  render,
  setInput,
  settle,
  test,
  WorkersPro,
} from './server-action-pages.helpers';

installTestHooks();

function worker(index: number) {
  return {
    id: `worker-${index}`,
    name: `worker-${index}`,
    queues: [index === 250 ? 'payments' : 'orders'],
    concurrency: 1,
    hostname: 'worker.test',
    pid: index + 1,
    status: index === 150 ? 'stale' : 'active',
    registeredAt: 1_700_000_000_000,
    lastSeen: 1_700_000_000_000 + index,
    activeJobs: 0,
    processedJobs: 0,
    failedJobs: 0,
    currentJob: null,
    uptime: 100,
  };
}

function serveWorkers() {
  const workers = Array.from({ length: 301 }, (_, index) => worker(index));
  globalThis.fetch = ((input: RequestInfo | URL) => {
    if (String(input).endsWith('/workers')) {
      return Promise.resolve(json({ ok: true, data: { workers } }));
    }
    return Promise.resolve(json({ ok: false, error: 'Unexpected request' }, 500));
  }) as typeof fetch;
}

describe('Workers inventory', () => {
  test('paginates the complete registry and exposes actions beyond the first 100', async () => {
    serveWorkers();
    const view = render(createElement(WorkersPro));
    try {
      await settle(50);
      expect(view.host.querySelectorAll('tbody tr')).toHaveLength(100);
      expect(view.host.textContent).not.toContain('worker-150');
      const next = [...view.host.querySelectorAll('button')].find(
        (candidate) => candidate.textContent?.trim() === 'Next'
      );
      expect(next).toBeDefined();
      clickSameTick(next as HTMLButtonElement, 1);
      await settle(10);
      expect(view.host.textContent).toContain('worker-150');
      expect(
        view.host.querySelector(
          'button[aria-label="Remove stale registry record for worker worker-150"]'
        )
      ).not.toBeNull();
    } finally {
      view.unmount();
    }
  });

  test('searches all workers by name, ID, or queue even from a later page', async () => {
    serveWorkers();
    const view = render(createElement(WorkersPro));
    try {
      await settle(50);
      const search = view.host.querySelector<HTMLInputElement>(
        'input[aria-label="Search workers"]'
      );
      expect(search).not.toBeNull();
      clickSameTick(buttonByText(view.host, 'Next'), 1);
      expect(view.host.querySelector('input[aria-label="Search workers"]')).toBe(search);
      setInput(search as HTMLInputElement, 'payments');
      await settle(10);
      expect((search as HTMLInputElement).value).toBe('payments');
      expect(view.host.querySelectorAll('tbody tr')).toHaveLength(1);
      expect(view.host.textContent).toContain('worker-250');
      expect(view.host.textContent).not.toContain('worker-150');
    } finally {
      view.unmount();
    }
  });
});
