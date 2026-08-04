import { useLocation, useNavigate } from 'react-router-dom';
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
  Workflows,
} from './workflows-ui.helpers';

installTestHooks();

function RouterHarness() {
  const location = useLocation();
  const navigate = useNavigate();
  return createElement(
    'div',
    null,
    createElement('output', { 'data-location': true }, `${location.pathname}${location.search}`),
    createElement('button', { type: 'button', onClick: () => navigate(-1) }, 'Browser back'),
    createElement('button', { type: 'button', onClick: () => navigate(1) }, 'Browser forward'),
    createElement(Workflows)
  );
}

function locationOf(host: ParentNode): string {
  return host.querySelector('[data-location]')?.textContent ?? '';
}

function installFetch(emptyWaiting = false): URL[] {
  const listQueries: URL[] = [];
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/workflows/stats') return Response.json(stats);
    if (url.pathname === '/workflows') {
      listQueries.push(url);
      if (emptyWaiting && url.searchParams.get('state') === 'waiting') {
        return Response.json({ available: true, executions: [], total: 0, limit: 25, offset: 0 });
      }
      const rows = [summary('row-a'), summary('row-b')];
      return Response.json({
        available: true,
        executions: rows,
        total: rows.length,
        limit: 25,
        offset: Number(url.searchParams.get('offset') ?? 0),
      });
    }
    const id = decodeURIComponent(url.pathname.slice('/workflows/'.length));
    const value = detail(id);
    return Response.json({
      ...value,
      execution: { ...value.execution, parentExecutionId: id === 'row-a' ? 'parent-1' : undefined },
    });
  }) as typeof fetch;
  return listQueries;
}

describe('Workflow shareable operator state', () => {
  test('canonicalizes hostile scope and aligns offsets before requesting data', async () => {
    const queries = installFetch(true);
    const route =
      '/workflows/waiting?kind=archive&state=failed&offset=1&workflow=checkout' +
      '&execution=..&tab=payloads&unknown=1';
    const { host } = render(
      createElement(MemoryRouter, { initialEntries: [route] }, createElement(RouterHarness))
    );
    await settle(20);

    expect(locationOf(host)).toBe('/workflows/waiting?workflow=checkout');
    expect(queries.at(-1)?.searchParams.get('kind')).toBe('active');
    expect(queries.at(-1)?.searchParams.get('state')).toBe('waiting');
    expect(queries.at(-1)?.searchParams.get('offset')).toBe('0');
  });

  test('restores execution and detail tab through Back and Forward', async () => {
    const queries = installFetch();
    const hostile =
      '/workflows/executions?kind=archive&workflow=refund&state=bogus' +
      '&offset=1&tab=history&unknown=1';
    const { host } = render(
      createElement(MemoryRouter, { initialEntries: [hostile] }, createElement(RouterHarness))
    );
    await settle(25);

    expect(locationOf(host)).toBe(
      '/workflows/executions?kind=archive&workflow=refund&execution=row-a'
    );
    expect(queries.at(-1)?.searchParams.get('kind')).toBe('archive');
    expect(queries.at(-1)?.searchParams.get('state')).toBeNull();
    click(host, 'History');
    expect(locationOf(host)).toContain('execution=row-a&tab=history');
    click(host, 'row-b');
    await settle(5);
    expect(locationOf(host)).toContain('execution=row-b');
    expect(locationOf(host)).not.toContain('tab=');

    click(host, 'Browser back');
    await settle(5);
    expect(locationOf(host)).toContain('execution=row-a&tab=history');
    expect(
      host.querySelector('[aria-label="Execution detail"] button[aria-pressed="true"]')?.textContent
    ).toContain('History');
    click(host, 'Browser forward');
    await settle(5);
    expect(locationOf(host)).toContain('execution=row-b');
  });

  test('pushes nested execution links and Back restores the prior detail', async () => {
    installFetch();
    const { host } = render(
      createElement(
        MemoryRouter,
        { initialEntries: ['/workflows/executions'] },
        createElement(RouterHarness)
      )
    );
    await settle(20);
    click(host, 'parent-1');
    await settle(5);
    expect(locationOf(host)).toContain('execution=parent-1');
    click(host, 'Browser back');
    await settle(5);
    expect(locationOf(host)).toContain('execution=row-a');
  });
});
