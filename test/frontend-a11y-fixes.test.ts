import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, NavLink, Route, Routes } from 'react-router-dom';
import { CommandPalette } from '../src/components/CommandPalette';
import { Copilot } from '../src/components/copilot/Copilot';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { useCopilotStore } from '../src/components/dashboard/stores/copilotStore';
import { titleFor, useDocumentTitle } from '../src/components/layout/pageTitle';
import { NAV } from '../src/components/layout/Sidebar';
import { CardHeader } from '../src/components/ui/Card';
import { Field, Input } from '../src/components/ui/form';
import { Database } from '../src/pages/control/Database';
import { DlqPro } from '../src/pages/control/DlqPro';
import { LogsPro } from '../src/pages/control/LogsPro';
import { QueueDetailPro } from '../src/pages/control/QueueDetailPro';
import { NotFound } from '../src/pages/NotFound';
import { fetchHealthWithTimeout, Settings } from '../src/pages/Settings';
import { ensureDom, settle } from './domSetup';

const realFetch = globalThis.fetch;
const realConfirm = window.confirm;
const mounted = new Set<() => void>();
let installedAnimationFrameShim = false;
let previousRequestAnimationFrame: PropertyDescriptor | undefined;
let previousCancelAnimationFrame: PropertyDescriptor | undefined;

function render(element: ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  let active = true;
  const unmount = () => {
    if (!active) return;
    active = false;
    act(() => root.unmount());
    host.remove();
    mounted.delete(unmount);
  };
  mounted.add(unmount);
  act(() => root.render(element));
  return { host, unmount };
}

async function waitForElement<T extends Element>(
  host: ParentNode,
  selector: string,
  timeoutMs = 1000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const element = host.querySelector<T>(selector);
    if (element) return element;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${selector}`);
    // Lazy module completion must settle inside React act(), especially when
    // the full coverage suite makes the chunk import slower than an isolated run.
    await settle(10);
  }
}

beforeEach(() => {
  ensureDom();
  useConnectionStore.setState({ baseUrl: '/api', token: '', agentToken: '' });
  useCopilotStore.getState().clear();
  useCopilotStore.getState().setOpen(false);
  installedAnimationFrameShim = false;
  if (!globalThis.requestAnimationFrame) {
    previousRequestAnimationFrame = Object.getOwnPropertyDescriptor(
      globalThis,
      'requestAnimationFrame'
    );
    previousCancelAnimationFrame = Object.getOwnPropertyDescriptor(
      globalThis,
      'cancelAnimationFrame'
    );
    installedAnimationFrameShim = true;
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback) =>
      setTimeout(() => callback(performance.now()), 0) as unknown as number;
    globalThis.cancelAnimationFrame = (id: number) => clearTimeout(id);
  }
});

afterEach(() => {
  try {
    for (const unmount of [...mounted]) unmount();
    globalThis.fetch = realFetch;
    window.confirm = realConfirm;
    useCopilotStore.getState().clear();
    useCopilotStore.getState().setOpen(false);
  } finally {
    if (installedAnimationFrameShim) {
      if (previousRequestAnimationFrame) {
        Object.defineProperty(globalThis, 'requestAnimationFrame', previousRequestAnimationFrame);
      } else {
        Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
      }
      if (previousCancelAnimationFrame) {
        Object.defineProperty(globalThis, 'cancelAnimationFrame', previousCancelAnimationFrame);
      } else {
        Reflect.deleteProperty(globalThis, 'cancelAnimationFrame');
      }
      installedAnimationFrameShim = false;
    }
  }
});

describe('form and heading semantics', () => {
  test('a compound Field label targets the actual input', () => {
    const { host, unmount } = render(
      createElement(
        Field,
        { label: 'Token', htmlFor: 'token-input' },
        createElement('div', {}, createElement(Input, { id: 'token-input' }))
      )
    );
    const label = host.querySelector('label');
    expect(label?.htmlFor).toBe('token-input');
    expect(label?.control).toBe(host.querySelector('#token-input'));
    unmount();
  });

  test('CardHeader starts at h2 and supports a nested heading level', () => {
    const { host, unmount } = render(
      createElement(
        'div',
        {},
        createElement(CardHeader, { title: 'Top card' }),
        createElement(CardHeader, { title: 'Nested card', headingLevel: 4 })
      )
    );
    expect(host.querySelector('h2')?.textContent).toBe('Top card');
    expect(host.querySelector('h4')?.textContent).toBe('Nested card');
    unmount();
  });

  test('the 404 code is the page h1', () => {
    const { host, unmount } = render(createElement(MemoryRouter, {}, createElement(NotFound)));
    expect(host.querySelector('h1')?.textContent).toBe('404');
    unmount();
  });
});

describe('route titles and navigation semantics', () => {
  test('classic and pro queue detail titles are decoded without throwing', () => {
    expect(titleFor('/queues/email%20jobs')).toBe('email jobs · Queue');
    expect(titleFor('/queues-classic/email%20jobs')).toBe('email jobs · Queue (classic)');
    expect(titleFor('/queues/%zz')).toContain('%zz');
  });

  test('route titles tolerate trailing slashes', () => {
    expect(titleFor('/settings/')).toBe('Settings');
    expect(titleFor('/queues/email%20jobs/')).toBe('email jobs · Queue');
  });

  test('Topbar keeps document.title in sync with the route', async () => {
    function TitleProbe() {
      useDocumentTitle(titleFor('/database'));
      return null;
    }
    const { unmount } = render(createElement(TitleProbe));
    await settle(1);
    expect(document.title).toBe('Database · bunqueue');
    unmount();
  });

  test('only the exact sidebar destination is aria-current', async () => {
    const items = NAV.flatMap((group) => group.items);
    const jobsItem = items.find((item) => item.to === '/jobs');
    const bulkItem = items.find((item) => item.to === '/jobs/bulk-add');
    const { host, unmount } = render(
      createElement(
        MemoryRouter,
        { initialEntries: ['/jobs/bulk-add'] },
        createElement(
          'nav',
          {},
          createElement(NavLink, { to: jobsItem?.to ?? '', end: jobsItem?.end }, 'Jobs'),
          createElement(NavLink, { to: bulkItem?.to ?? '', end: bulkItem?.end }, 'Bulk Add')
        )
      )
    );
    await settle(1);
    const jobs = host.querySelector<HTMLAnchorElement>('a[href="/jobs"]');
    const bulk = host.querySelector<HTMLAnchorElement>('a[href="/jobs/bulk-add"]');
    expect(jobs?.getAttribute('aria-current')).toBeNull();
    expect(bulk?.getAttribute('aria-current')).toBe('page');
    unmount();
  });
});

describe('modal focus and background isolation', () => {
  test('CommandPalette traps Tab, makes siblings inert, and restores focus', async () => {
    const { host, unmount } = render(
      createElement(
        MemoryRouter,
        {},
        createElement(
          'div',
          {},
          createElement('button', { id: 'palette-opener', type: 'button' }, 'Open'),
          createElement(CommandPalette)
        )
      )
    );
    const opener = host.querySelector<HTMLButtonElement>('#palette-opener') as HTMLButtonElement;
    opener.focus();
    act(() => window.dispatchEvent(new window.Event('command-palette:open')));
    await settle(5);

    const dialog = host.querySelector<HTMLElement>('[role="dialog"]') as HTMLElement;
    const input = dialog.querySelector<HTMLInputElement>('input') as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute('role')).toBe('combobox');
    expect(input.getAttribute('aria-controls')).toBe('command-palette-results');
    const listbox = dialog.querySelector<HTMLElement>('[role="listbox"]');
    const options = dialog.querySelectorAll<HTMLElement>('[role="option"]');
    expect(listbox).not.toBeNull();
    expect(options.length).toBeGreaterThan(1);
    expect(options[0]?.getAttribute('aria-selected')).toBe('true');
    expect(input.getAttribute('aria-activedescendant')).toBe(options[0]?.id);

    act(() =>
      input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    );
    expect(options[0]?.getAttribute('aria-selected')).toBe('false');
    expect(options[1]?.getAttribute('aria-selected')).toBe('true');
    expect(input.getAttribute('aria-activedescendant')).toBe(options[1]?.id);
    expect(opener.inert).toBe(true);
    expect(opener.getAttribute('aria-hidden')).toBe('true');

    const focusables = dialog.querySelectorAll<HTMLElement>('input, button:not([disabled])');
    const last = focusables[focusables.length - 1];
    last.focus();
    act(() =>
      document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    );
    expect(document.activeElement).toBe(input);

    act(() =>
      document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    );
    await settle(2);
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(opener.inert).toBe(false);
    expect(opener.getAttribute('aria-hidden')).toBeNull();
    expect(document.activeElement).toBe(opener);
    unmount();
  });

  test('Copilot isolates the app and restores focus to its trigger', async () => {
    useCopilotStore.getState().addUser('Conversation that must not be lost accidentally');
    let approveClear = false;
    let confirmCalls = 0;
    window.confirm = () => {
      confirmCalls += 1;
      return approveClear;
    };
    const { host, unmount } = render(
      createElement(
        'div',
        {},
        createElement('button', { id: 'copilot-background', type: 'button' }, 'Background'),
        createElement(Copilot)
      )
    );
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Open Copilot"]');
    act(() => trigger?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    const clear = await waitForElement<HTMLButtonElement>(host, '[aria-label="Clear chat"]');
    const background = host.querySelector<HTMLElement>('#copilot-background') as HTMLElement;
    const dialog = host.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(background.inert).toBe(true);
    expect(dialog?.contains(document.activeElement)).toBe(true);

    act(() => clear.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    expect(confirmCalls).toBe(1);
    expect(useCopilotStore.getState().messages).toHaveLength(1);
    approveClear = true;
    const clearAgain = await waitForElement<HTMLButtonElement>(host, '[aria-label="Clear chat"]');
    act(() => clearAgain.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    expect(confirmCalls).toBe(2);
    expect(useCopilotStore.getState().messages).toHaveLength(0);

    act(() =>
      document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    );
    await settle(5);
    const restored = host.querySelector<HTMLButtonElement>('[aria-label="Open Copilot"]');
    expect(background.inert).toBe(false);
    expect(document.activeElement).toBe(restored);
    unmount();
  });
});

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

  test('QueueDetailPro reports a failed recent-jobs fetch instead of an empty list', async () => {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/queues/summary')) {
        return Promise.resolve(
          Response.json([
            {
              name: 'orders',
              paused: false,
              counts: {
                waiting: 0,
                prioritized: 0,
                active: 0,
                completed: 1,
                failed: 0,
                delayed: 0,
              },
            },
          ])
        );
      }
      if (url.includes('/dashboard/queues/orders')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ok: true,
              name: 'orders',
              counts: {
                waiting: 0,
                prioritized: 0,
                active: 0,
                'waiting-children': 0,
                completed: 1,
                failed: 0,
                delayed: 0,
                paused: 0,
              },
              paused: false,
              priorityCounts: {},
              dlqPreview: [],
              timestamp: Date.now(),
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        );
      }
      if (url.includes('/jobs/list')) {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: false, error: 'job list unavailable' }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          })
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ ok: false, error: 'config unavailable' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        })
      );
    }) as typeof fetch;

    const { host, unmount } = render(
      createElement(
        MemoryRouter,
        { initialEntries: ['/queues/orders'] },
        createElement(
          Routes,
          {},
          createElement(Route, { path: '/queues/:name', element: createElement(QueueDetailPro) })
        )
      )
    );
    await settle(20);
    expect(host.textContent).toContain('Could not load recent jobs — job list unavailable');
    expect(host.textContent).not.toContain('No recent jobs.');
    unmount();
  });

  test('DLQ discovery failure never reports a healthy zero', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: false, error: 'discovery unavailable' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        })
      )) as typeof fetch;
    const { host, unmount } = render(createElement(MemoryRouter, {}, createElement(DlqPro)));
    await settle(20);
    expect(host.textContent).toContain('Health status is unavailable');
    expect(host.textContent).toContain('Unavailable');
    expect(host.textContent).not.toContain('Healthy');
    unmount();
  });

  test('a non-SSE activity response is shown as an error, not “Connecting” forever', async () => {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/events')) {
        return Promise.resolve(
          new Response(JSON.stringify({ login: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, queues: [], total: 0, limit: 500, offset: 0 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );
    }) as typeof fetch;
    const { host, unmount } = render(createElement(MemoryRouter, {}, createElement(LogsPro)));
    await settle(20);
    expect(host.textContent).toContain('Event stream unavailable');
    expect(host.textContent).toContain('expected text/event-stream');
    expect(host.textContent).not.toContain('Connecting to the event stream');
    unmount();
  });
});
