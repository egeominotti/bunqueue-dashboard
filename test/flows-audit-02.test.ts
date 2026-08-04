import {
  describe,
  expect,
  findDirectedCycle,
  installTestHooks,
  type JobFull,
  mockJobs,
  snapshot,
  test,
  walkFlow,
} from './flows-audit.helpers';

installTestHooks();

describe('Flows — canonical v2.8.55 topology', () => {
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
