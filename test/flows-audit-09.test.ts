import {
  act,
  createElement,
  createRoot,
  describe,
  expect,
  Flows,
  installTestHooks,
  type JobFull,
  MemoryRouter,
  recentFlowsStorageKey,
  response,
  settle,
  snapshot,
  test,
  useConnectionStore,
} from './flows-audit.helpers';

installTestHooks();

describe('Flows — connection/UI integrity', () => {
  test('token/base retarget invalidates the graph and never persists authenticated recents', async () => {
    useConnectionStore.setState({ token: 'tenant-a' });
    let resolveTenantB!: (value: Response) => void;
    const tenantBRoot = new Promise<Response>((resolve) => {
      resolveTenantB = resolve;
    });
    let heldTenantB = false;
    const requests: Array<{ url: string; auth: string | null }> = [];
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const auth = new Headers(init?.headers).get('authorization');
      requests.push({ url, auth });
      const id = decodeURIComponent(new URL(url).pathname.split('/').at(-1) ?? '');
      if (auth === 'Bearer tenant-b' && id === 'root' && !heldTenantB) {
        heldTenantB = true;
        return tenantBRoot;
      }
      const job =
        id === 'root'
          ? snapshot('root', { childrenIds: ['child'], dependsOn: ['child'] })
          : snapshot('child', { parentId: 'root' });
      return Promise.resolve(response({ ok: true, job }));
    }) as typeof fetch;

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        createElement(MemoryRouter, { initialEntries: ['/flows?root=root'] }, createElement(Flows))
      );
    });

    try {
      await settle(10);
      expect(container.querySelector('[data-flow-node="child"]')).not.toBeNull();
      expect(localStorage.getItem(recentFlowsStorageKey('http://flows.test'))).toBeNull();

      act(() => useConnectionStore.setState({ token: 'tenant-b' }));
      await settle(0);
      expect(container.querySelector('[data-flow-node="root"]')).toBeNull();
      expect(container.textContent).toContain('Loading flow…');

      act(() =>
        resolveTenantB(
          response({
            ok: true,
            job: snapshot('root', { childrenIds: ['child'], dependsOn: ['child'] }),
          })
        )
      );
      await settle(10);
      expect(container.querySelector('[data-flow-node="child"]')).not.toBeNull();
      expect(requests.some((request) => request.auth === 'Bearer tenant-b')).toBe(true);
      expect(localStorage.getItem(recentFlowsStorageKey('http://flows.test'))).toBeNull();

      act(() => useConnectionStore.setState({ baseUrl: 'http://flows-other.test' }));
      await settle(10);
      expect(requests.at(-1)?.url.startsWith('http://flows-other.test/')).toBe(true);
      expect(requests.at(-1)?.auth).toBe('Bearer tenant-b');
      expect(localStorage.getItem(recentFlowsStorageKey('http://flows-other.test'))).toBeNull();
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});

describe('Flows — demo fixture parity', () => {
  test('uses canonical symmetric links and waiting-children parent states', async () => {
    const href = window.location.href;
    window.location.href = 'http://localhost:5273/';
    const { installDemo } = await import('../src/lib/demo/install.ts?flows-audit=1');
    const cleanup = installDemo();
    try {
      const rootResponse = await window.fetch('http://localhost:5273/api/jobs/flow-order-9a3f');
      const rootBody = (await rootResponse.json()) as { job: JobFull };
      expect(rootBody.job.state).toBe('waiting-children');
      expect(rootBody.job.dependsOn).toEqual(rootBody.job.childrenIds);

      const shipResponse = await window.fetch('http://localhost:5273/api/jobs/flow-ship-2');
      const shipBody = (await shipResponse.json()) as { job: JobFull };
      expect(shipBody.job.state).toBe('waiting-children');
      expect(shipBody.job.dependsOn).toEqual(['flow-label-4']);
      expect(shipBody.job.parentId).toBe('flow-order-9a3f');
    } finally {
      cleanup();
      window.location.href = href;
    }
  });
});
