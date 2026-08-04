import {
  act,
  createElement,
  Database,
  describe,
  expect,
  fetchHealthWithTimeout,
  installTestHooks,
  render,
  Settings,
  settle,
  test,
} from './frontend-a11y-fixes.helpers';

installTestHooks();

describe('honest async failures', () => {
  test('the Settings health request aborts and reports its deadline', async () => {
    let aborted = false;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(init.signal?.reason);
          },
          { once: true }
        );
      })) as typeof fetch;
    await expect(fetchHealthWithTimeout('/health', {}, 5)).rejects.toThrow('timed out');
    expect(aborted).toBe(true);
  });

  test('the Settings deadline includes a health body that never finishes', async () => {
    let signal: AbortSignal | null = null;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? null;
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start() {
              // Headers arrive, but the body intentionally remains open forever.
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      );
    }) as typeof fetch;
    await expect(fetchHealthWithTimeout('/health', {}, 5)).rejects.toThrow('timed out');
    expect(signal?.aborted).toBe(true);
  });

  test('Settings treats health HTTP 503 as reachable but degraded', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ ok: false, status: 'degraded', uptime: 42, version: '2.8.55' }),
          {
            status: 503,
            headers: { 'content-type': 'application/json' },
          }
        )
      )) as typeof fetch;
    const { host, unmount } = render(createElement(Settings));
    const testButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Test connection')
    );
    act(() => testButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    await settle(10);
    expect(host.textContent).toContain('Server reachable');
    expect(host.textContent).toContain('bunqueue v2.8.55 · degraded');
    expect(host.querySelector('[role="status"].text-danger')?.textContent).toContain('degraded');
    unmount();
  });

  test('Database reports metadata and schema failures instead of hiding or loading forever', async () => {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/db/info')) {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: false, error: 'metadata unavailable' }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          })
        );
      }
      if (url.includes('/db/tables/jobs/schema')) {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: false, error: 'schema unavailable' }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          })
        );
      }
      if (url.includes('/db/tables/jobs?')) {
        return Promise.resolve(
          Response.json({
            ok: true,
            table: 'jobs',
            columns: ['id'],
            rows: [[1]],
            rowids: [1],
            truncatedCells: [[false]],
            total: 1,
            limit: 50,
            offset: 0,
            orderBy: null,
            dir: 'asc',
            filter: null,
          })
        );
      }
      if (url.endsWith('/db/tables')) {
        return Promise.resolve(
          Response.json({ ok: true, tables: [{ name: 'jobs', rows: 1, columns: 1 }] })
        );
      }
      return Promise.resolve(Response.json({ ok: true }));
    }) as typeof fetch;

    const { host, unmount } = render(createElement(Database));
    await settle(30);
    expect(host.textContent).toContain('Could not read database metadata — metadata unavailable');
    const schemaButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'schema'
    );
    act(() => schemaButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    await settle(2);
    expect(host.textContent).toContain('Could not read schema');
    expect(host.textContent).toContain('schema unavailable');
    expect(host.textContent).not.toContain('Reading schema of jobs…');
    unmount();
  });
});
