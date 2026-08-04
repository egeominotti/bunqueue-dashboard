import { afterEach } from 'bun:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  describe,
  expect,
  Flows,
  installTestHooks,
  MemoryRouter,
  response,
  settle,
  snapshot,
  test,
} from './flows-audit.helpers';

const unmounts = new Set<() => void>();

afterEach(() => {
  for (const unmount of unmounts) unmount();
  unmounts.clear();
});
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
    createElement(Flows)
  );
}

function renderFlow(route: string) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const unmount = () => {
    act(() => root.unmount());
    host.remove();
    unmounts.delete(unmount);
  };
  unmounts.add(unmount);
  act(() => {
    root.render(
      createElement(MemoryRouter, { initialEntries: [route] }, createElement(RouterHarness))
    );
  });
  return host;
}

function click(host: ParentNode, label: string) {
  const button = [...host.querySelectorAll('button')].find((item) =>
    item.textContent?.includes(label)
  );
  if (!button) throw new Error(`Missing button ${label}`);
  act(() => button.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
}

function locationOf(host: ParentNode): string {
  return host.querySelector('[data-location]')?.textContent ?? '';
}

function installGraphFetch(calls: string[] = []) {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === '/flows/create' && init?.method === 'POST') {
      return new Promise<Response>((resolve) =>
        setTimeout(() => resolve(response({ ok: true, result: { root: { id: 'root' } } })), 0)
      );
    }
    const id = decodeURIComponent(url.pathname.split('/').at(-1) ?? '');
    calls.push(id);
    const job =
      id === 'root'
        ? snapshot('root', { childrenIds: ['child'], dependsOn: ['child'] })
        : snapshot(id, id === 'child' ? { parentId: 'root' } : {});
    return new Promise<Response>((resolve) =>
      setTimeout(() => resolve(response({ ok: true, job })), 0)
    );
  }) as typeof fetch;
}

describe('Flow shareable operator state', () => {
  test('canonicalizes hostile params without issuing a hostile root request', async () => {
    const calls: string[] = [];
    installGraphFetch(calls);
    const host = renderFlow('/flows?root=..&mode=wat&node=bad%20node&unknown=1');
    await settle(10);
    expect(locationOf(host)).toBe('/flows');
    expect(calls).toEqual([]);
  });

  test('restores selected nodes and tool mode through Back and Forward', async () => {
    installGraphFetch();
    const host = renderFlow('/flows?root=root&node=child');
    await settle(15);
    expect(locationOf(host)).toBe('/flows?root=root&node=child');
    expect(host.querySelector('[aria-label="Selected job details"]')?.textContent).toContain(
      'child'
    );

    click(host, 'root');
    expect(locationOf(host)).toBe('/flows?root=root&node=root');
    click(host, 'create');
    expect(locationOf(host)).toBe('/flows?root=root&mode=create&node=root');
    click(host, 'Browser back');
    await settle(2);
    expect(locationOf(host)).toBe('/flows?root=root&node=root');
    click(host, 'Browser back');
    await settle(2);
    expect(locationOf(host)).toBe('/flows?root=root&node=child');
    click(host, 'Browser forward');
    await settle(2);
    expect(locationOf(host)).toBe('/flows?root=root&node=root');
  });

  test('creator onOpen returns to Explore and reloads an unchanged root', async () => {
    const calls: string[] = [];
    installGraphFetch(calls);
    const host = renderFlow('/flows?root=root&mode=create&node=child');
    await settle(15);
    const initialRootCalls = calls.filter((id) => id === 'root').length;
    click(host, 'Run add');
    await settle(5);
    click(host, 'Open created flow');
    await settle(15);

    expect(locationOf(host)).toBe('/flows?root=root&node=root');
    expect(
      host.querySelector('[aria-label="Job Flow tools"] button[aria-pressed="true"]')?.textContent
    ).toContain('explore');
    expect(calls.filter((id) => id === 'root').length).toBeGreaterThan(initialRootCalls);
  });
});
