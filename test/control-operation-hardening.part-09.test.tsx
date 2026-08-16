import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { Diagnostics } from '../src/pages/control/Diagnostics';
import { useQueueDepth } from '../src/pages/control/queueDetail/useQueueDepth';
import { ensureDom, renderHook, settle } from './domSetup';

ensureDom();

const realFetch = globalThis.fetch;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const mounted = new Set<() => void>();

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
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
  useConnectionStore.setState({ baseUrl: '/api', token: '', agentToken: '', refreshMs: 3000 });
});

describe('queue depth connection lifecycle', () => {
  test('resets the same queue name before sampling a retargeted server', () => {
    const intervals: Array<() => void> = [];
    globalThis.setInterval = ((handler: TimerHandler) => {
      if (typeof handler !== 'function') throw new Error('Expected an interval callback');
      intervals.push(handler as () => void);
      return intervals.length as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    globalThis.clearInterval = (() => undefined) as typeof clearInterval;

    const hook = renderHook(
      ({ counts }: { counts: { waiting: number } }) => useQueueDepth('orders', counts),
      { counts: { waiting: 100 } }
    );
    act(() => intervals.at(-1)?.());
    expect(hook.result.current.depth).toEqual([100]);

    act(() => useConnectionStore.setState({ baseUrl: 'http://server-b.test' }));
    hook.rerender({ counts: { waiting: 1 } });
    expect(hook.result.current.depth).toEqual([]);
    act(() => intervals.at(-1)?.());
    expect(hook.result.current.depth).toEqual([1]);
    hook.unmount();
  });
});

describe('diagnostic action ownership', () => {
  test('drops a ping result after an A to B retarget', async () => {
    let resolvePing!: (response: Response) => void;
    const ping = new Promise<Response>((resolve) => {
      resolvePing = resolve;
    });
    globalThis.fetch = ((input) => {
      const url = new URL(String(input));
      if (url.pathname === '/ping' && url.hostname === 'server-a.test') return ping;
      return Promise.resolve(diagnosticResponse(url.pathname));
    }) as typeof fetch;
    const view = render(createElement(Diagnostics));
    await settle(10);
    click(view.host, 'Ping');
    await settle(1);
    expect(view.host.textContent).toContain('Ping · …');

    act(() => useConnectionStore.setState({ baseUrl: 'http://server-b.test' }));
    await settle(5);
    expect(view.host.textContent).not.toContain('Ping ·');
    await act(async () => {
      resolvePing(Response.json({ ok: true, data: { pong: true, time: 1 } }));
      await Promise.resolve();
    });
    expect(view.host.textContent).not.toContain('Ping ·');
  });

  test('admits only one same-task GC mutation', async () => {
    let gcCalls = 0;
    globalThis.fetch = ((input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/gc') {
        gcCalls += 1;
        return Promise.resolve(
          Response.json({
            ok: true,
            before: { rss: 10, heapUsed: 4, heapTotal: 6 },
            after: { rss: 8, heapUsed: 3, heapTotal: 6 },
          })
        );
      }
      return Promise.resolve(diagnosticResponse(path));
    }) as typeof fetch;
    const view = render(createElement(Diagnostics));
    await settle(10);
    invokeTwice(button(view.host, 'Compact (GC)'));
    await settle(10);
    expect(gcCalls).toBe(1);
  });
});

function diagnosticResponse(path: string): Response {
  if (path === '/healthz' || path === '/live') return new Response('OK');
  if (path === '/ready') {
    return Response.json({ ok: true, ready: true, storage: { diskFull: false } });
  }
  if (path === '/metrics') {
    return Response.json({
      ok: true,
      metrics: { totalPushed: 0, totalPulled: 0, totalCompleted: 0, totalFailed: 0 },
    });
  }
  if (path === '/health') {
    return Response.json({
      ok: true,
      status: 'healthy',
      memory: { rss: 1, heapUsed: 1, heapTotal: 1 },
      connections: { tcp: 0, ws: 0, sse: 0 },
    });
  }
  if (path === '/storage') {
    return Response.json({ ok: true, data: { diskFull: false, error: null } });
  }
  if (path === '/stats') {
    return Response.json({
      ok: true,
      stats: { totalPushed: 0, totalPulled: 0, totalCompleted: 0, totalFailed: 0 },
    });
  }
  throw new Error(`Unexpected diagnostic request: ${path}`);
}

function render(element: ReactElement): { host: HTMLElement } {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const unmount = mountCleanup(root, host);
  mounted.add(unmount);
  act(() => root.render(element));
  return { host };
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
