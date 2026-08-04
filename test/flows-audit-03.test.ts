import {
  describe,
  expect,
  installTestHooks,
  type JobFull,
  mockJobs,
  resolveFlowRoot,
  response,
  snapshot,
  test,
  walkFlow,
} from './flows-audit.helpers';

installTestHooks();

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
});
