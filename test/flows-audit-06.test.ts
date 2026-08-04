import {
  describe,
  expect,
  installTestHooks,
  resolveFlowRoot,
  response,
  snapshot,
  test,
  useConnectionStore,
  walkFlow,
} from './flows-audit.helpers';

installTestHooks();

describe('Flows — connection/UI integrity', () => {
  test('standalone traversal pins every request to one base URL and bearer snapshot', async () => {
    useConnectionStore.setState({ baseUrl: 'http://tenant-a.test', token: 'tenant-a' });
    let releaseRoot!: (value: Response) => void;
    const heldRoot = new Promise<Response>((resolve) => {
      releaseRoot = resolve;
    });
    const requests: Array<{ url: string; auth: string | null }> = [];
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const id = decodeURIComponent(new URL(url).pathname.split('/').at(-1) ?? '');
      requests.push({ url, auth: new Headers(init?.headers).get('authorization') });
      if (id === 'root') return heldRoot;
      return Promise.resolve(response({ ok: true, job: snapshot('child', { parentId: 'root' }) }));
    }) as typeof fetch;

    const traversal = walkFlow('root');
    await Promise.resolve();
    useConnectionStore.setState({ baseUrl: 'http://tenant-b.test', token: 'tenant-b' });
    releaseRoot(
      response({
        ok: true,
        job: snapshot('root', { childrenIds: ['child'], dependsOn: ['child'] }),
      })
    );

    const graph = await traversal;
    expect(graph.jobs.has('child')).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests.every(({ url }) => url.startsWith('http://tenant-a.test/'))).toBe(true);
    expect(requests.every(({ auth }) => auth === 'Bearer tenant-a')).toBe(true);
  });

  test('standalone parent climb also pins the original target', async () => {
    useConnectionStore.setState({ baseUrl: 'http://tenant-a.test', token: 'tenant-a' });
    let releaseLeaf!: (value: Response) => void;
    const heldLeaf = new Promise<Response>((resolve) => {
      releaseLeaf = resolve;
    });
    const requests: Array<{ url: string; auth: string | null }> = [];
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const id = decodeURIComponent(new URL(url).pathname.split('/').at(-1) ?? '');
      requests.push({ url, auth: new Headers(init?.headers).get('authorization') });
      if (id === 'leaf') return heldLeaf;
      return Promise.resolve(response({ ok: true, job: snapshot('root') }));
    }) as typeof fetch;

    const resolution = resolveFlowRoot('leaf');
    await Promise.resolve();
    useConnectionStore.setState({ baseUrl: 'http://tenant-b.test', token: 'tenant-b' });
    releaseLeaf(response({ ok: true, job: snapshot('leaf', { parentId: 'root' }) }));

    expect((await resolution).id).toBe('root');
    expect(requests).toHaveLength(2);
    expect(requests.every(({ url }) => url.startsWith('http://tenant-a.test/'))).toBe(true);
    expect(requests.every(({ auth }) => auth === 'Bearer tenant-a')).toBe(true);
  });

  test('an abort during the final referenced node rejects instead of returning a partial graph', async () => {
    let releaseChild!: (value: Response) => void;
    const heldChild = new Promise<Response>((resolve) => {
      releaseChild = resolve;
    });
    let markChildStarted!: () => void;
    const childStarted = new Promise<void>((resolve) => {
      markChildStarted = resolve;
    });
    let childSignal: AbortSignal | undefined;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const id = decodeURIComponent(new URL(String(input)).pathname.split('/').at(-1) ?? '');
      if (id === 'child') {
        childSignal = init?.signal ?? undefined;
        markChildStarted();
        return heldChild;
      }
      throw new Error(`Unexpected request for ${id}`);
    }) as typeof fetch;

    const controller = new AbortController();
    const traversal = walkFlow(
      'root',
      snapshot('root', { childrenIds: ['child'], dependsOn: ['child'] }),
      { signal: controller.signal }
    );
    const settled = traversal.then(
      () => ({ error: null }),
      (error: unknown) => ({ error })
    );
    await childStarted;
    controller.abort();
    expect(childSignal?.aborted).toBe(true);
    releaseChild(response({ ok: true, job: snapshot('child', { parentId: 'root' }) }));

    expect((await settled).error).toMatchObject({ name: 'AbortError' });
  });
});
