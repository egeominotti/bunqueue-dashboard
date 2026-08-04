import {
  describe,
  expect,
  installTestHooks,
  mockJobs,
  response,
  snapshot,
  test,
  walkFlow,
} from './flows-audit.helpers';

installTestHooks();

describe('Flows — root and snapshot integrity', () => {
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
