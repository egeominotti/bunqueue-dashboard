import {
  describe,
  expect,
  installTestHooks,
  mockJobs,
  snapshot,
  test,
  walkFlow,
} from './flows-audit.helpers';

installTestHooks();

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
});
