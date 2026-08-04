import {
  act,
  createElement,
  createRoot,
  describe,
  expect,
  Flows,
  installTestHooks,
  MemoryRouter,
  response,
  settle,
  snapshot,
  test,
  useConnectionStore,
  useNavigate,
} from './flows-audit.helpers';

installTestHooks();

describe('Flows — connection/UI integrity', () => {
  test('retarget aborts A, traverses only B, and ignores A even when fetch ignores abort', async () => {
    useConnectionStore.setState({ baseUrl: 'http://tenant-a.test', token: 'tenant-a' });
    let releaseTenantA!: (value: Response) => void;
    const heldTenantA = new Promise<Response>((resolve) => {
      releaseTenantA = resolve;
    });
    let tenantASignal: AbortSignal | undefined;
    const requests: Array<{ url: string; auth: string | null }> = [];
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const parsed = new URL(url);
      const id = decodeURIComponent(parsed.pathname.split('/').at(-1) ?? '');
      requests.push({ url, auth: new Headers(init?.headers).get('authorization') });
      if (parsed.host === 'tenant-a.test' && id === 'root') {
        tenantASignal = init?.signal ?? undefined;
        // Deliberately ignore AbortSignal to exercise the publication guard.
        return heldTenantA;
      }
      const job =
        id === 'root'
          ? snapshot('root', { childrenIds: ['child-b'], dependsOn: ['child-b'] })
          : snapshot(id, { parentId: 'root' });
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
      await settle(0);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url.startsWith('http://tenant-a.test/')).toBe(true);
      const retargetRequestIndex = requests.length;

      act(() =>
        useConnectionStore.setState({ baseUrl: 'http://tenant-b.test', token: 'tenant-b' })
      );
      await settle(10);

      expect(tenantASignal?.aborted).toBe(true);
      expect(container.querySelector('[data-flow-node="child-b"]')).not.toBeNull();
      const replacementRequests = requests.slice(retargetRequestIndex);
      expect(replacementRequests).toHaveLength(2);
      expect(replacementRequests.every(({ url }) => url.startsWith('http://tenant-b.test/'))).toBe(
        true
      );
      expect(replacementRequests.every(({ auth }) => auth === 'Bearer tenant-b')).toBe(true);

      act(() =>
        releaseTenantA(
          response({
            ok: true,
            job: snapshot('root', { childrenIds: ['child-a'], dependsOn: ['child-a'] }),
          })
        )
      );
      await settle(10);

      expect(container.querySelector('[data-flow-node="child-b"]')).not.toBeNull();
      expect(container.querySelector('[data-flow-node="child-a"]')).toBeNull();
      expect(requests.some(({ url }) => url.endsWith('/jobs/child-a'))).toBe(false);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test('URL replacement aborts the previous traversal before starting the next one', async () => {
    let releaseA!: (value: Response) => void;
    const heldA = new Promise<Response>((resolve) => {
      releaseA = resolve;
    });
    let signalA: AbortSignal | undefined;
    const calls: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const id = decodeURIComponent(new URL(String(input)).pathname.split('/').at(-1) ?? '');
      calls.push(id);
      if (id === 'a') {
        signalA = init?.signal ?? undefined;
        return heldA;
      }
      return Promise.resolve(response({ ok: true, job: snapshot(id) }));
    }) as typeof fetch;

    function Harness() {
      const navigate = useNavigate();
      return createElement(
        'div',
        null,
        createElement(
          'button',
          { type: 'button', onClick: () => navigate('/flows?root=b') },
          'Go B'
        ),
        createElement(Flows)
      );
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        createElement(MemoryRouter, { initialEntries: ['/flows?root=a'] }, createElement(Harness))
      );
    });

    try {
      await settle(0);
      const goB = [...container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('Go B')
      );
      if (!goB) throw new Error('Go B button missing');
      act(() => goB.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));

      expect(signalA?.aborted).toBe(true);
      await settle(10);
      expect(container.querySelector('[data-flow-node="b"]')).not.toBeNull();

      act(() => releaseA(response({ ok: true, job: snapshot('a') })));
      await settle(10);
      expect(container.querySelector('[data-flow-node="a"]')).toBeNull();
      expect(calls).toEqual(['a', 'b']);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
