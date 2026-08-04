import {
  click,
  createElement,
  describe,
  detail,
  expect,
  installTestHooks,
  MemoryRouter,
  render,
  setSelect,
  settle,
  stats,
  summary,
  test,
  Workflows,
} from './workflows-ui.helpers';

installTestHooks();

describe('Workflow Engine dashboard behavior', () => {
  test('retains the last good snapshot and exposes retry when refresh fails', async () => {
    let fail = false;
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      if (fail && url.pathname === '/workflows') {
        return Response.json({ error: 'database busy' }, { status: 503 });
      }
      if (url.pathname === '/workflows/stats') return Response.json(stats);
      if (url.pathname === '/workflows') {
        return Response.json({
          available: true,
          executions: [summary('stable-row')],
          total: 1,
          limit: 25,
          offset: 0,
        });
      }
      return Response.json(detail('stable-row'));
    }) as typeof fetch;

    const { host } = render(
      createElement(
        MemoryRouter,
        { initialEntries: ['/workflows/executions'] },
        createElement(Workflows)
      )
    );
    await settle(20);
    fail = true;
    click(host, 'Refresh');
    await settle(20);
    expect(host.textContent).toContain('showing the last snapshot');
    expect(host.textContent).toContain('stable-row');
    expect(host.textContent).toContain('Retry');
  });

  test('archive scope and state filters produce the exact agent query', async () => {
    const queries: URL[] = [];
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/workflows/stats') return Response.json(stats);
      if (url.pathname === '/workflows') {
        queries.push(url);
        return Response.json({
          available: true,
          executions: [summary('refund-archive', 'completed')],
          total: 1,
          limit: 25,
          offset: 0,
        });
      }
      return Response.json(detail('refund-archive'));
    }) as typeof fetch;

    const { host } = render(
      createElement(
        MemoryRouter,
        { initialEntries: ['/workflows/archive'] },
        createElement(Workflows)
      )
    );
    await settle(20);
    expect(queries.at(-1)?.searchParams.get('kind')).toBe('archive');
    const stateSelect = [...host.querySelectorAll('select')].at(-1);
    if (!stateSelect) throw new Error('Missing workflow state filter');
    setSelect(stateSelect, 'failed');
    await settle(20);
    expect(queries.at(-1)?.searchParams.get('kind')).toBe('archive');
    expect(queries.at(-1)?.searchParams.get('state')).toBe('failed');
  });

  test('shows a recoverable error when execution detail is no longer available', async () => {
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/workflows/stats') return Response.json(stats);
      if (url.pathname === '/workflows') {
        return Response.json({
          available: true,
          executions: [summary('deleted-detail')],
          total: 1,
          limit: 25,
          offset: 0,
        });
      }
      return Response.json({ error: 'Workflow execution not found' }, { status: 404 });
    }) as typeof fetch;

    const { host } = render(
      createElement(
        MemoryRouter,
        { initialEntries: ['/workflows/executions'] },
        createElement(Workflows)
      )
    );
    await settle(20);
    expect(host.textContent).toContain('Workflow execution not found');
    expect(host.textContent).toContain('Retry');
  });

  test('surfaces a malformed persisted step as an agent error instead of rendering it', async () => {
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/workflows/stats') return Response.json(stats);
      if (url.pathname === '/workflows') {
        return Response.json({
          available: true,
          executions: [summary('malformed-step')],
          total: 1,
          limit: 25,
          offset: 0,
        });
      }
      return Response.json(
        { error: 'Workflow store contains an invalid step record' },
        { status: 400 }
      );
    }) as typeof fetch;

    const { host } = render(
      createElement(
        MemoryRouter,
        { initialEntries: ['/workflows/executions'] },
        createElement(Workflows)
      )
    );
    await settle(20);
    expect(host.textContent).toContain('Workflow store contains an invalid step record');
    expect(host.textContent).toContain('Retry');
    expect(host.textContent).not.toContain('Step timeline');
  });
});
