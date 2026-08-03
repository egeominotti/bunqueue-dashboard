import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import type { JobFull } from '../src/lib/bqTypes';
import {
  Flows,
  findDirectedCycle,
  flowJobIdError,
  flowStateStyle,
  recentFlowsStorageKey,
  resolveFlowRoot,
  walkFlow,
} from '../src/pages/control/Flows';
import { ensureDom, settle } from './domSetup';

const realFetch = globalThis.fetch;

const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const snapshot = (id: string, overrides: Partial<JobFull> = {}): JobFull => ({
  id,
  queue: 'flow-q',
  state: 'waiting',
  parentId: null,
  childrenIds: [],
  dependsOn: [],
  ...overrides,
});

function mockJobs(
  jobs: Record<string, JobFull | Response | undefined>,
  calls: string[] = []
): void {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    // Bunqueue v2.8.55 deliberately treats /jobs/:id as an opaque segment.
    const id = path.slice(path.lastIndexOf('/') + 1);
    calls.push(id);
    const value = jobs[id];
    if (value instanceof Response) return Promise.resolve(value.clone());
    if (!value) return Promise.resolve(response({ ok: false, error: 'Job not found' }, 404));
    return Promise.resolve(response({ ok: true, job: value }));
  }) as typeof fetch;
}

beforeEach(() => {
  ensureDom();
  useConnectionStore.setState({ baseUrl: 'http://flows.test', token: '', agentToken: '' });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  useConnectionStore.setState({ baseUrl: '/api', token: '', agentToken: '' });
  localStorage.removeItem(recentFlowsStorageKey('http://flows.test'));
  localStorage.removeItem(recentFlowsStorageKey('http://tenant-a.test'));
  localStorage.removeItem(recentFlowsStorageKey('http://tenant-b.test'));
});

describe('Flows — canonical v2.8.55 topology', () => {
  test('collapses symmetric child/dependsOn metadata without inventing a cycle', async () => {
    mockJobs({
      root: snapshot('root', {
        state: 'waiting-children',
        childrenIds: ['charge', 'notify'],
        dependsOn: ['charge', 'notify'],
      }),
      charge: snapshot('charge', { state: 'completed', parentId: 'root' }),
      notify: snapshot('notify', { parentId: 'root', dependsOn: ['charge'] }),
    });

    const graph = await walkFlow('root');
    expect(graph.edges).toEqual([
      { from: 'root', to: 'charge', kind: 'child' },
      { from: 'root', to: 'notify', kind: 'child' },
      { from: 'charge', to: 'notify', kind: 'depends' },
    ]);
    expect(graph.cycle).toBeNull();
    expect(graph.issues).toEqual([]);
    expect(graph.policyNotes).toEqual([]);
  });

  test('reports a broken child backlink instead of drawing it as healthy', async () => {
    mockJobs({
      root: snapshot('root', { childrenIds: ['child'], dependsOn: ['child'] }),
      child: snapshot('child', { parentId: 'someone-else' }),
    });

    const graph = await walkFlow('root');
    expect(graph.issues).toContain('Child child points to parent someone-else, not root');
  });

  test('reports remove/ignore dependency removal as HTTP-snapshot ambiguity', async () => {
    for (const policy of ['removeDependencyOnFailure', 'ignoreDependencyOnFailure'] as const) {
      mockJobs({
        root: snapshot('root', {
          state: 'waiting-children',
          childrenIds: ['failed-child', 'pending-child'],
          dependsOn: ['pending-child'],
        }),
        'failed-child': snapshot('failed-child', {
          state: 'failed',
          parentId: 'root',
          [policy]: true,
        }),
        'pending-child': snapshot('pending-child', { parentId: 'root' }),
      });

      const graph = await walkFlow('root');
      expect(graph.issues).toEqual([]);
      expect(graph.policyNotes).toHaveLength(1);
      expect(graph.policyNotes[0]).toContain(policy);
      expect(graph.policyNotes[0]).toContain('cannot prove whether the policy fired');
      expect(graph.edges).toEqual([
        { from: 'root', to: 'failed-child', kind: 'child' },
        { from: 'root', to: 'pending-child', kind: 'child' },
      ]);
    }
  });

  test('accepts continueParentOnFailure after DLQ retry without restoring sibling deps', async () => {
    mockJobs({
      root: snapshot('root', {
        state: 'waiting',
        childrenIds: ['failed-child', 'still-running'],
        dependsOn: [],
      }),
      'failed-child': snapshot('failed-child', {
        state: 'waiting',
        parentId: 'root',
        continueParentOnFailure: true,
        attempts: 0,
        timeline: [
          { state: 'failed', timestamp: 1, attempt: 1 },
          { state: 'waiting', timestamp: 2 },
        ],
      }),
      'still-running': snapshot('still-running', { state: 'active', parentId: 'root' }),
    });

    const graph = await walkFlow('root');
    expect(graph.issues).toEqual([]);
    expect(graph.policyNotes).toHaveLength(2);
    expect(graph.policyNotes.every((note) => note.includes('continueParentOnFailure'))).toBe(true);
    expect(graph.policyNotes.some((note) => note.includes('still-running'))).toBe(true);
    expect(graph.edges).toEqual([
      { from: 'root', to: 'failed-child', kind: 'child' },
      { from: 'root', to: 'still-running', kind: 'child' },
    ]);
  });

  test('does not claim that a configured policy has already fired', async () => {
    mockJobs({
      root: snapshot('root', { childrenIds: ['child'], dependsOn: [] }),
      child: snapshot('child', {
        parentId: 'root',
        removeDependencyOnFailure: true,
      }),
    });

    const graph = await walkFlow('root');
    expect(graph.issues).toEqual([]);
    expect(graph.policyNotes).toHaveLength(1);
    expect(graph.policyNotes[0]).toContain('removeDependencyOnFailure may have released it');
    expect(graph.policyNotes[0]).toContain('cannot prove whether the policy fired');
  });

  test('does not mistake a retryable historical failure for proof that a policy fired', async () => {
    mockJobs({
      root: snapshot('root', { childrenIds: ['retrying'], dependsOn: [] }),
      retrying: snapshot('retrying', {
        state: 'delayed',
        parentId: 'root',
        removeDependencyOnFailure: true,
        attempts: 1,
        maxAttempts: 3,
        timeline: [{ state: 'failed', timestamp: 1, attempt: 1 }],
      }),
    });

    const graph = await walkFlow('root');
    expect(graph.issues).toEqual([]);
    expect(graph.policyNotes).toHaveLength(1);
    expect(graph.policyNotes[0]).toContain('HTTP snapshot cannot prove');
  });

  test('keeps continue-policy ambiguity when retry/DLQ history fell out of the timeline cap', async () => {
    mockJobs({
      root: snapshot('root', {
        childrenIds: ['retried', 'sibling'],
        dependsOn: [],
      }),
      retried: snapshot('retried', {
        state: 'waiting',
        parentId: 'root',
        continueParentOnFailure: true,
        timeline: Array.from({ length: 20 }, (_, index) => ({
          state: 'waiting',
          timestamp: index + 100,
        })),
      }),
      sibling: snapshot('sibling', { state: 'active', parentId: 'root' }),
    });

    const graph = await walkFlow('root');
    expect(graph.issues).toEqual([]);
    expect(graph.policyNotes).toHaveLength(2);
    expect(graph.policyNotes.every((note) => note.includes('child retried'))).toBe(true);
  });

  test('still reports a missing structural dependency when no release policy applies', async () => {
    mockJobs({
      root: snapshot('root', { childrenIds: ['child'], dependsOn: [] }),
      child: snapshot('child', { parentId: 'root' }),
    });

    const graph = await walkFlow('root');
    expect(graph.issues).toEqual(['Parent root lists child child without the matching dependency']);
    expect(graph.policyNotes).toEqual([]);
  });

  test('does not let mutually exclusive policy flags hide corrupt topology', async () => {
    mockJobs({
      root: snapshot('root', { childrenIds: ['child'], dependsOn: [] }),
      child: snapshot('child', {
        parentId: 'root',
        failParentOnFailure: true,
        continueParentOnFailure: true,
      }),
    });

    const graph = await walkFlow('root');
    expect(graph.issues).toContain('Job child enables mutually exclusive failure policies');
    expect(graph.issues).toContain('Parent root lists child child without the matching dependency');
    expect(graph.policyNotes).toEqual([]);
  });

  test('does not invent symmetry issues when an unavailable child may have released the parent', async () => {
    mockJobs({
      root: snapshot('root', {
        state: 'waiting',
        childrenIds: ['removed-on-fail', 'sibling'],
        dependsOn: [],
      }),
      sibling: snapshot('sibling', { parentId: 'root' }),
    });

    const graph = await walkFlow('root');
    expect(graph.failed).toBe(1);
    expect(graph.issues).toEqual([]);
  });

  test('flags a real dependency cycle while still terminating', async () => {
    mockJobs({
      a: snapshot('a', { dependsOn: ['b'] }),
      b: snapshot('b', { dependsOn: ['a'] }),
    });

    const graph = await walkFlow('a');
    expect(graph.cycle).not.toBeNull();
    expect(graph.cycle?.[0]).toBe(graph.cycle?.at(-1));
    expect(findDirectedCycle(['x', 'y'], [{ from: 'x', to: 'y', kind: 'depends' }])).toBeNull();
  });

  test('caps discovery before a huge fan-out can inflate the edge queue', async () => {
    const children = Array.from({ length: 600 }, (_, index) => `child-${index}`);
    const jobs: Record<string, JobFull> = {
      root: snapshot('root', { childrenIds: children, dependsOn: children }),
    };
    for (const child of children) jobs[child] = snapshot(child, { parentId: 'root' });
    const calls: string[] = [];
    mockJobs(jobs, calls);

    const graph = await walkFlow('root');
    expect(graph.jobs.size).toBe(500);
    expect(graph.edges).toHaveLength(499);
    expect(graph.truncated).toBe(true);
    expect(calls).toHaveLength(500);
  });
});

describe('Flows — root and snapshot integrity', () => {
  test('climbs beyond the old 12-hop limit to the actual root', async () => {
    const jobs: Record<string, JobFull> = {};
    for (let index = 0; index < 15; index++) {
      jobs[`node-${index}`] = snapshot(`node-${index}`, {
        parentId: index === 14 ? null : `node-${index + 1}`,
      });
    }
    const calls: string[] = [];
    mockJobs(jobs, calls);

    const root = await resolveFlowRoot('node-0');
    expect(root.id).toBe('node-14');
    expect(root.hops).toBe(14);
    expect(root.path.map((job) => job.id)).toEqual(
      Array.from({ length: 15 }, (_, index) => `node-${index}`)
    );
    expect(calls).toHaveLength(15);
  });

  test('keeps the requested seed and reports a missing parent backlink', async () => {
    mockJobs({
      child: snapshot('child', { parentId: 'parent' }),
      parent: snapshot('parent'),
    });

    const root = await resolveFlowRoot('child');
    const graph = await walkFlow(root.id, root.job, { seedPath: root.path });

    expect([...graph.jobs.keys()]).toEqual(['parent', 'child']);
    expect(graph.truncated).toBe(false);
    expect(graph.issues).toContain('Parent parent does not list child child');
  });

  test('keeps a deep requested seed across the full upstream 100-level limit', async () => {
    const jobs: Record<string, JobFull> = {};
    for (let index = 0; index <= 100; index++) {
      jobs[`n${index}`] = snapshot(`n${index}`, {
        parentId: index === 0 ? null : `n${index - 1}`,
        childrenIds: index === 100 ? [] : [`n${index + 1}`],
        dependsOn: index === 100 ? [] : [`n${index + 1}`],
      });
    }
    mockJobs(jobs);

    const root = await resolveFlowRoot('n100');
    const graph = await walkFlow(root.id, root.job, { seedPath: root.path });

    expect(root.id).toBe('n0');
    expect(graph.jobs.has('n100')).toBe(true);
    expect(graph.jobs.size).toBe(101);
    expect(graph.truncated).toBe(false);
  });

  test('renders from the oldest survivor when a completed parent was removed', async () => {
    mockJobs({ child: snapshot('child', { parentId: 'removed-root' }) });

    const root = await resolveFlowRoot('child');
    expect(root).toMatchObject({ id: 'child', missingParent: 'removed-root' });
    const graph = await walkFlow(root.id, root.job, {
      seedPath: root.path,
      limitations: [`Ancestor ${root.missingParent} is unavailable`],
    });
    expect([...graph.jobs.keys()]).toEqual(['child']);
    expect(graph.limitations).toEqual(['Ancestor removed-root is unavailable']);
  });

  test('does not silently accept an interrupted parent climb', async () => {
    mockJobs({
      child: snapshot('child', { parentId: 'parent' }),
      parent: response({ ok: false, error: 'storage unavailable' }, 503),
    });

    await expect(resolveFlowRoot('child')).rejects.toThrow(
      'Could not resolve the flow root because parent parent could not be loaded'
    );
  });

  test('detects a corrupt parent cycle', async () => {
    mockJobs({
      a: snapshot('a', { parentId: 'b' }),
      b: snapshot('b', { parentId: 'a' }),
    });

    await expect(resolveFlowRoot('a')).rejects.toThrow('Flow parent cycle detected');
  });

  test('rejects a malformed successful root response and names malformed children', async () => {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const id = String(input).endsWith('/root') ? 'root' : 'child';
      return Promise.resolve(
        id === 'root'
          ? response({
              ok: true,
              job: snapshot('root', { childrenIds: ['child'], dependsOn: ['child'] }),
            })
          : response({ ok: true })
      );
    }) as typeof fetch;
    const graph = await walkFlow('root');
    expect(graph.failed).toBe(1);
    expect(graph.failures.get('child')).toContain('returned no job snapshot');

    globalThis.fetch = (() => Promise.resolve(response({ ok: true }))) as typeof fetch;
    await expect(walkFlow('root')).rejects.toThrow('returned no job snapshot');

    globalThis.fetch = (() => Promise.resolve(response({ job: snapshot('root') }))) as typeof fetch;
    await expect(walkFlow('root')).rejects.toThrow('returned an invalid success envelope');
  });

  test('rejects a root snapshot when any topology field is absent', async () => {
    for (const field of ['parentId', 'childrenIds', 'dependsOn'] as const) {
      const partial: Record<string, unknown> = { ...snapshot('root') };
      delete partial[field];
      globalThis.fetch = (() =>
        Promise.resolve(response({ ok: true, job: partial }))) as typeof fetch;

      await expect(walkFlow('root')).rejects.toThrow(
        field === 'parentId' ? 'invalid parentId' : `invalid ${field} list`
      );
    }
  });

  test('rejects a partial snapshot preserved in the resolved seed path', async () => {
    const root = snapshot('root', {
      childrenIds: ['seed'],
      dependsOn: ['seed'],
    });
    const partialSeed: Record<string, unknown> = {
      ...snapshot('seed', { parentId: 'root' }),
    };
    delete partialSeed.childrenIds;

    await expect(
      walkFlow('root', root, {
        seedPath: [partialSeed as unknown as JobFull, root],
      })
    ).rejects.toThrow('invalid childrenIds list');
  });

  test('reports a partial referenced snapshot as unavailable instead of empty topology', async () => {
    const partialChild: Record<string, unknown> = {
      ...snapshot('child', { parentId: 'root' }),
    };
    delete partialChild.dependsOn;
    mockJobs({
      root: snapshot('root', { childrenIds: ['child'], dependsOn: ['child'] }),
      child: response({ ok: true, job: partialChild }),
    });

    const graph = await walkFlow('root');
    expect(graph.failed).toBe(1);
    expect(graph.failures.get('child')).toContain('invalid dependsOn list');
    expect(graph.jobs.get('child')?.state).toBe('unknown');
  });
});

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
