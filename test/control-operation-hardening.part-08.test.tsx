import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import type { ServerConfig, ServerStatus } from '../src/lib/bqTypes';
import { ConfigCard } from '../src/pages/control/server/ConfigCard';
import { ServerControl } from '../src/pages/control/ServerControl';
import { ensureDom, settle } from './domSetup';
import { changeControl } from './flow-operation-races.helpers';

ensureDom();

const realFetch = globalThis.fetch;
const realConfirm = globalThis.window.confirm;
const mounted = new Set<() => void>();

const config: ServerConfig = {
  command: 'bunqueue start',
  httpPort: 6790,
  tcpPort: 6789,
  dataPath: './data/a.db',
  extraEnv: {},
};

beforeEach(() => {
  useConnectionStore.setState({
    baseUrl: 'http://server-a.test',
    token: 'server-a-token',
    agentToken: 'agent-a-token',
    refreshMs: 60_000,
  });
});

afterEach(() => {
  for (const unmount of [...mounted]) unmount();
  globalThis.fetch = realFetch;
  globalThis.window.confirm = realConfirm;
  useConnectionStore.setState({ baseUrl: '/api', token: '', agentToken: '', refreshMs: 3000 });
});

describe('control lifecycle and configuration ownership', () => {
  test('ConfigCard preserves a dirty draft and refuses its stale revision', async () => {
    const requests: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json(
        { ok: false, error: 'Configuration changed since revision 1; current revision is 2' },
        { status: 409 }
      );
    }) as typeof fetch;
    const first = status(config, 1, false);
    const latestConfig = { ...config, command: 'newer operator command', dataPath: './data/b.db' };
    const view = render(
      createElement(ConfigCard, {
        status: first,
        onSaved: () => undefined,
        running: false,
        transitioning: false,
      })
    );

    const command = view.host.querySelector<HTMLInputElement>('[name="server-command"]');
    if (!command) throw new Error('Missing command field');
    changeControl(command, 'my unsaved command');
    view.rerender(
      createElement(ConfigCard, {
        status: status(latestConfig, 2, false),
        onSaved: () => undefined,
        running: false,
        transitioning: false,
      })
    );
    expect(command.value).toBe('my unsaved command');

    click(view.host, 'Save config');
    await settle(5);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      command: 'my unsaved command',
      expectedRevision: 1,
    });
    expect(view.host.textContent).toContain('Reload latest');
    click(view.host, 'Reload latest');
    expect(view.host.querySelector<HTMLInputElement>('[name="server-command"]')?.value).toBe(
      'newer operator command'
    );
  });

  test('ConfigCard admits only one same-task Save & restart sequence', async () => {
    let puts = 0;
    let restarts = 0;
    globalThis.window.confirm = () => true;
    globalThis.fetch = (async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/control/config') {
        puts += 1;
        const body = JSON.parse(String(init?.body)) as ServerConfig;
        return Response.json({ ...body, configRevision: 2 });
      }
      if (path === '/control/restart') {
        restarts += 1;
        return Response.json(status(config, 2, true));
      }
      throw new Error(`Unexpected request: ${path}`);
    }) as typeof fetch;
    const view = render(
      createElement(ConfigCard, {
        status: status(config, 1, true),
        onSaved: () => undefined,
        running: true,
        transitioning: false,
      })
    );
    const command = view.host.querySelector<HTMLInputElement>('[name="server-command"]');
    if (!command) throw new Error('Missing command field');
    changeControl(command, 'bunqueue start --new');

    invokeTwice(button(view.host, 'Save & restart'));
    await settle(10);
    expect(puts).toBe(1);
    expect(restarts).toBe(1);
    expect(view.host.querySelector<HTMLInputElement>('[name="server-command"]')?.value).toBe(
      'bunqueue start --new'
    );
  });

  test('ServerControl admits only one reentrant restart', async () => {
    let restarts = 0;
    globalThis.window.confirm = () => true;
    globalThis.fetch = (async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/control/restart') {
        restarts += 1;
        return Response.json(status(config, 1, true));
      }
      if (path === '/control/status') return Response.json(status(config, 1, true));
      if (path === '/control/logs') return Response.json({ lines: [] });
      if (path === '/health') {
        return Response.json({
          ok: true,
          memory: { rss: 1, heapUsed: 1, heapTotal: 1 },
          connections: { tcp: 0, ws: 0, sse: 0 },
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    }) as typeof fetch;
    const view = render(createElement(ServerControl));
    await settle(15);

    invokeTwice(exactButton(view.host, 'Restart'));
    await settle(10);
    expect(restarts).toBe(1);
  });

  test('Save & restart shares its lifecycle lock with ServerControl', async () => {
    let puts = 0;
    let restarts = 0;
    let resolveConfig!: (response: Response) => void;
    const configResponse = new Promise<Response>((resolve) => {
      resolveConfig = resolve;
    });
    globalThis.window.confirm = () => true;
    globalThis.fetch = (async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/control/config') {
        puts += 1;
        return configResponse;
      }
      if (path === '/control/restart') {
        restarts += 1;
        return Response.json(status(config, 2, true));
      }
      if (path === '/control/status') return Response.json(status(config, 1, true));
      if (path === '/control/logs') return Response.json({ lines: [] });
      if (path === '/health') {
        return Response.json({
          ok: true,
          memory: { rss: 1, heapUsed: 1, heapTotal: 1 },
          connections: { tcp: 0, ws: 0, sse: 0 },
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    }) as typeof fetch;
    const view = render(createElement(ServerControl));
    await settle(15);
    const command = view.host.querySelector<HTMLInputElement>('[name="server-command"]');
    if (!command) throw new Error('Missing command field');
    changeControl(command, 'bunqueue start --shared-lock');

    act(() => {
      button(view.host, 'Save & restart').click();
      exactButton(view.host, 'Restart').click();
    });
    expect(puts).toBe(1);
    expect(restarts).toBe(0);
    resolveConfig(
      Response.json({ ...config, command: 'bunqueue start --shared-lock', configRevision: 2 })
    );
    await settle(15);
    expect(restarts).toBe(1);
  });
});

function status(value: ServerConfig, configRevision: number, running: boolean): ServerStatus {
  return {
    status: running ? 'running' : 'stopped',
    generation: running ? 1 : 0,
    configRevision,
    pid: running ? 123 : null,
    startedAt: running ? 1 : null,
    exitCode: null,
    healthy: running,
    config: value,
    runningConfig: running ? value : null,
    db: null,
  };
}

function render(element: ReactElement): {
  host: HTMLElement;
  rerender: (next: ReactElement) => void;
} {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const unmount = mountCleanup(root, host);
  mounted.add(unmount);
  act(() => root.render(element));
  return {
    host,
    rerender: (next) => act(() => root.render(next)),
  };
}

function mountCleanup(root: Root, host: HTMLElement): () => void {
  let active = true;
  const unmount = () => {
    if (!active) return;
    active = false;
    act(() => root.unmount());
    host.remove();
    mounted.delete(unmount);
  };
  return unmount;
}

function button(host: ParentNode, text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((item) =>
    item.textContent?.includes(text)
  );
  if (!found) throw new Error(`Missing button containing ${text}`);
  return found;
}

function exactButton(host: ParentNode, text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find(
    (item) => item.textContent?.trim() === text
  );
  if (!found) throw new Error(`Missing button ${text}`);
  return found;
}

function click(host: ParentNode, text: string): void {
  act(() => button(host, text).click());
}

function invokeTwice(control: HTMLButtonElement): void {
  const propsKey = Object.getOwnPropertyNames(control).find((key) =>
    key.startsWith('__reactProps$')
  );
  const props = propsKey
    ? ((control as unknown as Record<string, unknown>)[propsKey] as { onClick?: () => void })
    : undefined;
  if (!props?.onClick) throw new Error('Missing React onClick handler');
  act(() => {
    props.onClick?.();
    props.onClick?.();
  });
}
