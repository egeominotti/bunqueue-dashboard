import {
  click,
  createElement,
  describe,
  detail,
  expect,
  installTestHooks,
  MemoryRouter,
  reconcileWorkflowSelection,
  render,
  settle,
  stats,
  summary,
  test,
  type WorkflowExecutionSummary,
  type WorkflowSelection,
  Workflows,
} from './workflows-ui.helpers';

installTestHooks();

describe('Workflow Engine dashboard behavior', () => {
  test('renders a dedicated operational surface for every Workflow route', async () => {
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/workflows/stats') return Response.json(stats);
      if (url.pathname === '/workflows') {
        const requested = url.searchParams.get('state');
        const state = requested === 'compensation' ? 'compensation-stuck' : requested || 'waiting';
        const row = {
          ...summary(`surface-${state}`, state as WorkflowExecutionSummary['state']),
          ...(url.searchParams.get('kind') === 'archive' ? { archivedAt: 3_000 } : {}),
        };
        return Response.json({
          available: true,
          executions: [row],
          total: 1,
          limit: 25,
          offset: 0,
        });
      }
      const id = decodeURIComponent(url.pathname.slice('/workflows/'.length));
      return Response.json({
        ...detail(id),
        execution: { ...detail(id).execution, archivedAt: 3_000 },
      });
    }) as typeof fetch;

    const surfaces = [
      ['/workflows', 'Needs attention'],
      ['/workflows/executions', 'Step state'],
      ['/workflows/waiting', 'Durable signals'],
      ['/workflows/compensation', 'Compensation ledger'],
      ['/workflows/archive', 'Immutable audit record'],
    ] as const;
    for (const [route, marker] of surfaces) {
      const view = render(
        createElement(MemoryRouter, { initialEntries: [route] }, createElement(Workflows))
      );
      await settle(20);
      expect(view.host.textContent).toContain(marker);
      view.unmount();
    }
  });

  test('selection reconciliation replaces vanished rows but preserves explicit links', () => {
    const pageSelection: WorkflowSelection = { id: 'gone', source: 'page' };
    expect(reconcileWorkflowSelection(pageSelection, [summary('next')])).toEqual({
      id: 'next',
      source: 'page',
    });
    const linked: WorkflowSelection = { id: 'child-outside-page', source: 'link' };
    expect(reconcileWorkflowSelection(linked, [summary('next')])).toBe(linked);
    expect(reconcileWorkflowSelection(pageSelection, [])).toBeNull();
  });

  test('pagination clears the old detail and selects from the new page', async () => {
    const details: string[] = [];
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/workflows/stats') return Response.json(stats);
      if (url.pathname === '/workflows') {
        const second = url.searchParams.get('offset') === '25';
        return Response.json({
          available: true,
          executions: [summary(second ? 'page-b' : 'page-a')],
          total: 26,
          limit: 25,
          offset: second ? 25 : 0,
        });
      }
      const id = decodeURIComponent(url.pathname.slice('/workflows/'.length));
      details.push(id);
      return Response.json(detail(id));
    }) as typeof fetch;

    const { host } = render(
      createElement(
        MemoryRouter,
        { initialEntries: ['/workflows/executions'] },
        createElement(Workflows)
      )
    );
    await settle(20);
    expect(host.textContent).toContain('page-a');
    click(host, 'Next');
    await settle(20);
    expect(host.textContent).toContain('page-b');
    expect(details.at(-1)).toBe('page-b');
  });

  test('a refresh that removes the selected row retargets its detail safely', async () => {
    let rows = [summary('row-a'), summary('row-b')];
    const details: string[] = [];
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/workflows/stats') return Response.json(stats);
      if (url.pathname === '/workflows') {
        return Response.json({
          available: true,
          executions: rows,
          total: rows.length,
          limit: 25,
          offset: 0,
        });
      }
      const id = decodeURIComponent(url.pathname.slice('/workflows/'.length));
      details.push(id);
      return Response.json(detail(id));
    }) as typeof fetch;

    const { host } = render(
      createElement(
        MemoryRouter,
        { initialEntries: ['/workflows/executions'] },
        createElement(Workflows)
      )
    );
    await settle(20);
    click(host, 'row-b');
    await settle(10);
    expect(details.at(-1)).toBe('row-b');
    rows = [summary('row-a')];
    click(host, 'Refresh');
    await settle(20);
    expect(details.at(-1)).toBe('row-a');
    expect(host.textContent).not.toContain('row-b');
  });
});
