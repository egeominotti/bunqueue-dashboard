import {
  click,
  createElement,
  describe,
  detail,
  expect,
  installTestHooks,
  MemoryRouter,
  render,
  settle,
  stats,
  summary,
  test,
  type WorkflowExecutionSummary,
  Workflows,
} from './workflows-ui.helpers';

installTestHooks();

describe('Workflow operational pagination', () => {
  test('navigates every operational store beyond its first 25 executions', async () => {
    const scenarios = [
      ['/workflows/waiting', 'waiting', 'active'],
      ['/workflows/compensation', 'compensation', 'active'],
      ['/workflows/archive', null, 'archive'],
    ] as const;

    for (const [route, expectedState, expectedKind] of scenarios) {
      const queries: URL[] = [];
      const mode = route.split('/').at(-1) ?? 'workflow';
      globalThis.fetch = (async (input) => {
        const url = new URL(String(input));
        if (url.pathname === '/workflows/stats') return Response.json(stats);
        if (url.pathname === '/workflows') {
          queries.push(url);
          const offset = Number(url.searchParams.get('offset') ?? 0);
          const count = offset === 25 ? 1 : 25;
          const state =
            mode === 'waiting'
              ? 'waiting'
              : mode === 'compensation'
                ? 'compensation-stuck'
                : 'completed';
          const executions = Array.from({ length: count }, (_, index) => {
            const ordinal = offset + index + 1;
            return {
              ...summary(`${mode}-${ordinal}`, state as WorkflowExecutionSummary['state']),
              ...(mode === 'archive' ? { archivedAt: 3_000 + ordinal } : {}),
            };
          });
          return Response.json({ available: true, executions, total: 26, limit: 25, offset });
        }
        const id = decodeURIComponent(url.pathname.slice('/workflows/'.length));
        return Response.json({
          ...detail(id),
          execution: {
            ...detail(id).execution,
            state:
              mode === 'waiting'
                ? 'waiting'
                : mode === 'compensation'
                  ? 'compensation-stuck'
                  : 'completed',
            archivedAt: mode === 'archive' ? 4_000 : undefined,
          },
        });
      }) as typeof fetch;

      const view = render(
        createElement(MemoryRouter, { initialEntries: [route] }, createElement(Workflows))
      );
      await settle(20);
      expect(view.host.textContent).toContain('1–25 of 26');
      click(view.host, 'Next');
      await settle(20);
      expect(view.host.textContent).toContain(`${mode}-26`);
      expect(view.host.textContent).toContain('26–26 of 26');
      expect(queries.at(-1)?.searchParams.get('offset')).toBe('25');
      expect(queries.at(-1)?.searchParams.get('kind')).toBe(expectedKind);
      expect(queries.at(-1)?.searchParams.get('state')).toBe(expectedState);
      click(view.host, 'Previous');
      await settle(20);
      expect(view.host.textContent).toContain(`${mode}-1`);
      view.unmount();
    }
  });

  test('overview uses bounded state queries and reports the complete attention total', async () => {
    const states: Array<string | null> = [];
    const attentionStats = {
      ...stats,
      activeTotal: 80,
      states: {
        running: 47,
        waiting: 30,
        completed: 0,
        failed: 2,
        compensating: 0,
        'compensation-stuck': 1,
      },
    };
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/workflows/stats') return Response.json(attentionStats);
      if (url.pathname === '/workflows') {
        const state = url.searchParams.get('state');
        states.push(state);
        if (!state) {
          return Response.json({
            available: true,
            executions: Array.from({ length: 25 }, (_, index) => summary(`running-${index}`)),
            total: 80,
            limit: 25,
            offset: 0,
          });
        }
        const total = state === 'waiting' ? 30 : state === 'failed' ? 2 : 1;
        const executionState = state as WorkflowExecutionSummary['state'];
        return Response.json({
          available: true,
          executions: Array.from({ length: Math.min(total, 25) }, (_, index) => ({
            ...summary(`${state}-${index + 1}`, executionState),
            createdAt: 10_000 - index,
          })),
          total,
          limit: 25,
          offset: 0,
        });
      }
      const id = decodeURIComponent(url.pathname.slice('/workflows/'.length));
      return Response.json(detail(id));
    }) as typeof fetch;

    const { host } = render(
      createElement(MemoryRouter, { initialEntries: ['/workflows'] }, createElement(Workflows))
    );
    await settle(25);
    expect(states.sort()).toEqual(['compensation-stuck', 'failed', 'waiting']);
    expect(host.textContent).toContain('showing 25 of 33');
    expect(host.textContent).toContain('waiting-1');
    expect(host.textContent).not.toContain('No intervention required');
  });
});
