import {
  act,
  createElement,
  createRoot,
  describe,
  expect,
  Flows,
  flowJobIdError,
  flowStateStyle,
  installTestHooks,
  MemoryRouter,
  mockJobs,
  recentFlowsStorageKey,
  resolveFlowRoot,
  response,
  settle,
  snapshot,
  test,
  walkFlow,
} from './flows-audit.helpers';

installTestHooks();

describe('Flows — connection/UI integrity', () => {
  test('recent ids and waiting-children styling are target/state specific', () => {
    expect(recentFlowsStorageKey('http://one')).not.toBe(recentFlowsStorageKey('http://two'));
    expect(flowStateStyle('waiting-children')).toContain('cyan');
    expect(flowJobIdError('safe-job_1.2~x:@+')).toBeNull();
    expect(flowJobIdError('space id')).toContain('path-safe IDs');
    expect(flowJobIdError('slash/id')).toContain('path-safe IDs');
    expect(flowJobIdError('.')).toContain('path traversal segment');
    expect(flowJobIdError('..')).toContain('path traversal segment');
  });

  test('round-trips colon, at, and plus in an opaque flow lookup', async () => {
    const id = 'job:@+';
    const requests: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      return Promise.resolve(response({ ok: true, job: snapshot(id) }));
    }) as typeof fetch;

    expect((await resolveFlowRoot(id)).id).toBe(id);
    expect(requests).toEqual([`http://flows.test/jobs/${id}`]);
    expect(new URL(requests[0] as string).pathname).toBe(`/jobs/${id}`);
  });

  test('walks server-provided percent, bracket, and pipe IDs byte-for-byte', async () => {
    const childId = 'child%id[eu]|1';
    const calls: string[] = [];
    mockJobs(
      {
        root: snapshot('root', { childrenIds: [childId], dependsOn: [childId] }),
        [childId]: snapshot(childId, { parentId: 'root' }),
      },
      calls
    );

    const graph = await walkFlow('root');
    expect([...graph.jobs.keys()]).toEqual(['root', childId]);
    expect(graph.edges).toEqual([{ from: 'root', to: childId, kind: 'child' }]);
    expect(calls).toEqual(['root', childId]);
  });

  test('rejects a dot-segment seed before starting a flow request', async () => {
    let requested = false;
    globalThis.fetch = (() => {
      requested = true;
      return Promise.resolve(response({ ok: true }));
    }) as typeof fetch;

    await expect(resolveFlowRoot('.')).rejects.toThrow('path traversal segment');
    await expect(walkFlow('..')).rejects.toThrow('path traversal segment');
    expect(requested).toBe(false);
  });

  test('rejects untransportable dot segments in server-provided topology', async () => {
    mockJobs({
      root: snapshot('root', { childrenIds: ['.'], dependsOn: ['.'] }),
    });
    await expect(walkFlow('root')).rejects.toThrow('invalid childrenIds list');

    mockJobs({ child: snapshot('child', { parentId: '..' }) });
    await expect(resolveFlowRoot('child')).rejects.toThrow('invalid parentId');
  });

  test('renders failure-policy ambiguity separately from topology inconsistencies', async () => {
    mockJobs({
      root: snapshot('root', { childrenIds: ['child'], dependsOn: [] }),
      child: snapshot('child', {
        parentId: 'root',
        ignoreDependencyOnFailure: true,
      }),
    });
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
      expect(container.textContent).toContain('1 failure-policy ambiguity');
      expect(container.textContent).toContain('informational');
      expect(container.textContent).not.toContain('topology inconsistency');
      const policyDetails = [...container.querySelectorAll('details')].find((details) =>
        details.textContent?.includes('failure-policy ambiguity')
      );
      expect(policyDetails?.className).toContain('text-muted');
      expect(policyDetails?.className).not.toContain('text-warning');
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test('long queue and parent identifiers wrap inside the selected-node panel', async () => {
    const parentId = 'p'.repeat(1024);
    const queue = `queue-${'q'.repeat(250)}`;
    mockJobs({
      [parentId]: snapshot(parentId, {
        queue,
        childrenIds: ['child'],
        dependsOn: ['child'],
      }),
      child: snapshot('child', { queue, parentId }),
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        createElement(MemoryRouter, { initialEntries: ['/flows?root=child'] }, createElement(Flows))
      );
    });

    try {
      await settle(10);
      const child = container.querySelector<HTMLButtonElement>('[data-flow-node="child"]');
      act(() => child?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
      const details = container.querySelector<HTMLElement>('[aria-label="Selected job details"]');
      const parentValue = [...(details?.querySelectorAll('span') ?? [])].find(
        (element) => element.textContent === parentId
      );
      const queueValue = [...(details?.querySelectorAll('span') ?? [])].find(
        (element) => element.textContent === queue
      );
      expect(parentValue?.className).toContain('min-w-0');
      expect(parentValue?.className).toContain('break-all');
      expect(queueValue?.className).toContain('break-all');
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
