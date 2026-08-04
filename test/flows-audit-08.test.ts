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
  useNavigate,
} from './flows-audit.helpers';

installTestHooks();

describe('Flows — connection/UI integrity', () => {
  test('unmount aborts the active traversal and a late response cannot advance it', async () => {
    let releaseRoot!: (value: Response) => void;
    const heldRoot = new Promise<Response>((resolve) => {
      releaseRoot = resolve;
    });
    let activeSignal: AbortSignal | undefined;
    const calls: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const id = decodeURIComponent(new URL(String(input)).pathname.split('/').at(-1) ?? '');
      calls.push(id);
      activeSignal = init?.signal ?? undefined;
      return heldRoot;
    }) as typeof fetch;

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        createElement(MemoryRouter, { initialEntries: ['/flows?root=root'] }, createElement(Flows))
      );
    });
    await settle(0);

    act(() => root.unmount());
    expect(activeSignal?.aborted).toBe(true);
    act(() =>
      releaseRoot(
        response({
          ok: true,
          job: snapshot('root', { childrenIds: ['late-child'], dependsOn: ['late-child'] }),
        })
      )
    );
    await settle(10);
    expect(calls).toEqual(['root']);
    container.remove();
  });

  test('URL navigation clears stale graph, syncs the field, and Refresh uses the URL root', async () => {
    let resolveB!: (value: Response) => void;
    const firstB = new Promise<Response>((resolve) => {
      resolveB = resolve;
    });
    const calls: string[] = [];
    let bCalls = 0;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const id = decodeURIComponent(new URL(String(input)).pathname.split('/').at(-1) ?? '');
      calls.push(id);
      if (id === 'b' && bCalls++ === 0) return firstB;
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
      await settle(10);
      expect((container.querySelector('[name="flow-job-id"]') as HTMLInputElement).value).toBe('a');
      expect(container.querySelector('[data-flow-node="a"]')).not.toBeNull();

      const goB = [...container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('Go B')
      );
      if (!goB) throw new Error('Go B button missing');
      act(() => goB.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
      await settle(0);

      expect((container.querySelector('[name="flow-job-id"]') as HTMLInputElement).value).toBe('b');
      expect(container.querySelector('[data-flow-node="a"]')).toBeNull();
      expect(container.textContent).toContain('Loading flow…');

      act(() => resolveB(response({ ok: true, job: snapshot('b') })));
      await settle(10);
      expect(container.querySelector('[data-flow-node="b"]')).not.toBeNull();

      const refresh = [...container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('Refresh')
      );
      if (!refresh) throw new Error('Refresh button missing');
      act(() => refresh.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
      await settle(10);
      expect(calls.at(-1)).toBe('b');
      expect(calls).toEqual(['a', 'b', 'b']);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
