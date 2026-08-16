import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import type { ServerConfig, ServerStatus } from '../src/lib/bqTypes';
import { ConfigCard } from '../src/pages/control/server/ConfigCard';
import { parseConfigSaveResponse } from '../src/pages/control/server/configEditor';
import { ServerControl } from '../src/pages/control/ServerControl';
import { ensureDom, settle } from './domSetup';
import { changeControl } from './flow-operation-races.helpers';

ensureDom();

const realFetch = globalThis.fetch;
const realConfirm = globalThis.window.confirm;
const mounted = new Set<() => void>();
const initialConfig: ServerConfig = {
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

describe('configuration save ordering', () => {
  test('a pending plain Save config excludes Restart until the save settles', async () => {
    const configResponse = deferred<Response>();
    let puts = 0;
    let restarts = 0;
    let currentConfig = initialConfig;
    let currentRevision = 1;
    globalThis.window.confirm = () => true;
    globalThis.fetch = (async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/control/config') {
        puts += 1;
        return configResponse.promise;
      }
      if (path === '/control/restart') {
        restarts += 1;
        return Response.json(status({ ...initialConfig, command: 'saved command' }, 2, true));
      }
      if (path === '/control/status') {
        return Response.json(status(currentConfig, currentRevision, true));
      }
      if (path === '/control/logs') return Response.json({ lines: [] });
      if (path === '/health') return Response.json(health());
      throw new Error(`Unexpected request: ${path}`);
    }) as typeof fetch;
    const view = render(createElement(ServerControl));
    await settle(15);
    const command = field(view.host);
    changeControl(command, 'saved command');

    act(() => {
      button(view.host, 'Save config').click();
      exactButton(view.host, 'Restart').click();
    });
    expect({ puts, restarts }).toEqual({ puts: 1, restarts: 0 });

    currentConfig = { ...initialConfig, command: 'saved command' };
    currentRevision = 2;
    configResponse.resolve(Response.json({ ...currentConfig, configRevision: currentRevision }));
    await settle(15);
    expect(field(view.host).value).toBe('saved command');
    act(() => exactButton(view.host, 'Restart').click());
    await settle(10);
    expect(restarts).toBe(1);
  });

  test('a pre-save poll cannot overwrite the accepted editor after PUT resolves', async () => {
    const configResponse = deferred<Response>();
    globalThis.fetch = (() => configResponse.promise) as typeof fetch;
    const view = render(
      createElement(ConfigCard, {
        status: status(initialConfig, 1, false),
        onSaved: () => undefined,
        running: false,
        transitioning: false,
      })
    );
    changeControl(field(view.host), 'saved command');
    act(() => button(view.host, 'Save config').click());

    view.rerender(configCard({ ...initialConfig }, 1));
    configResponse.resolve(
      Response.json({ ...initialConfig, command: 'saved command', configRevision: 2 })
    );
    await settle(10);
    expect(field(view.host).value).toBe('saved command');

    const accepted = { ...initialConfig, command: 'saved command' };
    view.rerender(configCard(accepted, 2));
    expect(field(view.host).value).toBe('saved command');
    view.rerender(configCard({ ...accepted, command: 'newer external command' }, 3));
    expect(field(view.host).value).toBe('newer external command');
  });

  test('request ordering rejects an arbitrary pre-save poll from a legacy agent', async () => {
    const configResponse = deferred<Response>();
    const saved = { ...initialConfig, command: 'saved command' };
    let latestRequest = 1;
    globalThis.fetch = (() => configResponse.promise) as typeof fetch;
    const card = (config: ServerConfig, requestId: number) =>
      createElement(ConfigCard, {
        status: status(config, undefined, false),
        onSaved: () => undefined,
        running: false,
        statusRequestId: requestId,
        getStatusRequestSequence: () => latestRequest,
        transitioning: false,
      });
    const view = render(card(initialConfig, 1));
    changeControl(field(view.host), saved.command);
    act(() => button(view.host, 'Save config').click());

    latestRequest = 2;
    view.rerender(card({ ...initialConfig, command: 'intermediate external command' }, 2));
    configResponse.resolve(Response.json(saved));
    await settle(10);
    expect(field(view.host).value).toBe(saved.command);

    latestRequest = 3;
    view.rerender(card(saved, 3));
    latestRequest = 4;
    view.rerender(card({ ...saved, command: 'newer external command' }, 4));
    expect(field(view.host).value).toBe('newer external command');
  });

  test('a malformed successful PUT preserves the dirty editor and reports failure', async () => {
    globalThis.fetch = (async () => Response.json({ configRevision: 2 })) as typeof fetch;
    const view = render(configCard(initialConfig, 1));
    changeControl(field(view.host), 'unsaved command');
    act(() => button(view.host, 'Save config').click());
    await settle(10);

    expect(field(view.host).value).toBe('unsaved command');
    expect(view.host.textContent).toContain('Configuration save returned a malformed response');
    expect(view.host.textContent).not.toContain('Saved');
  });

  test('the save response parser validates every field and optional revision', () => {
    expect(parseConfigSaveResponse({ ...initialConfig, configRevision: 2 })).toEqual({
      config: initialConfig,
      revision: 2,
    });
    const malformed = [
      null,
      {},
      { ...initialConfig, command: '' },
      { ...initialConfig, httpPort: 0 },
      { ...initialConfig, tcpPort: initialConfig.httpPort },
      { ...initialConfig, dataPath: 1 },
      { ...initialConfig, extraEnv: { INVALID: 1 } },
      { ...initialConfig, configRevision: null },
      { ...initialConfig, configRevision: Number.MAX_SAFE_INTEGER + 1 },
    ];
    for (const response of malformed) {
      expect(() => parseConfigSaveResponse(response)).toThrow(
        'Configuration save returned a malformed response'
      );
    }
  });
});

function configCard(config: ServerConfig, revision: number): ReactElement {
  return createElement(ConfigCard, {
    status: status(config, revision, false),
    onSaved: () => undefined,
    running: false,
    transitioning: false,
  });
}

function status(
  config: ServerConfig,
  configRevision: number | undefined,
  running: boolean
): ServerStatus {
  return {
    status: running ? 'running' : 'stopped',
    generation: running ? 1 : 0,
    ...(configRevision === undefined ? {} : { configRevision }),
    pid: running ? 123 : null,
    startedAt: running ? 1 : null,
    exitCode: null,
    healthy: running,
    config,
    runningConfig: running ? config : null,
    db: null,
  };
}

function health() {
  return {
    ok: true,
    memory: { rss: 1, heapUsed: 1, heapTotal: 1 },
    connections: { tcp: 0, ws: 0, sse: 0 },
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
  return { host, rerender: (next) => act(() => root.render(next)) };
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

function field(host: ParentNode): HTMLInputElement {
  const found = host.querySelector<HTMLInputElement>('[name="server-command"]');
  if (!found) throw new Error('Missing command field');
  return found;
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}
