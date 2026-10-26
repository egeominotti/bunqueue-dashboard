import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import type { HistoryWindow } from '../src/features/metric-history/model';
import { useMetricHistory } from '../src/features/metric-history/useMetricHistory';
import { renderHook, settle } from './domSetup';

const realFetch = globalThis.fetch;
let originalConnection: ReturnType<typeof useConnectionStore.getState>;
const mounted = new Set<() => void>();
const response = (value: number) =>
  Response.json({
    ok: true,
    metrics: {
      meta: { count: 10000, prevTS: Date.now(), prevCount: value },
      data: [value],
      count: 1,
    },
  });

beforeEach(() => {
  originalConnection = useConnectionStore.getState();
  useConnectionStore.setState({
    baseUrl: 'http://queue.test',
    agentBaseUrl: 'http://agent.test',
    token: '',
    agentToken: '',
  });
});
afterEach(() => {
  for (const unmount of mounted) unmount();
  mounted.clear();
  globalThis.fetch = realFetch;
  useConnectionStore.setState(originalConnection, true);
});

describe('native history hook lifecycle', () => {
  test('waits for a queue and loads a wall-clock view from the actual adapter', async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      return response(3);
    }) as typeof fetch;
    const hook = renderHook(({ queue }: { queue: string }) => useMetricHistory(queue, '1h'), {
      queue: '',
    });
    mounted.add(hook.unmount);
    await settle(1);
    expect(requests).toBe(0);
    expect(hook.result.current.view).toBeUndefined();
    hook.rerender({ queue: 'orders' });
    await settle(5);
    expect(requests).toBe(2);
    expect(hook.result.current.view?.series.completed.total).toBe(3);
    expect(hook.result.current.loading).toBe(false);
  });

  test('clears and aborts old reads on queue, window, server, agent and credential changes', async () => {
    const signals: AbortSignal[] = [];
    const finish: Array<(value: Response) => void> = [];
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init!.signal!);
      return new Promise<Response>((resolve) => finish.push(resolve));
    }) as typeof fetch;
    const hook = renderHook(
      ({ queue, window }: { queue: string; window: HistoryWindow }) =>
        useMetricHistory(queue, window),
      { queue: 'orders', window: '1h' }
    );
    mounted.add(hook.unmount);
    await act(async () => {
      finish[0](response(7));
      finish[1](response(2));
    });
    expect(hook.result.current.view?.series.completed.total).toBe(7);
    hook.rerender({ queue: 'invoices', window: '1h' });
    expect(hook.result.current.view).toBeUndefined();
    expect(signals[0].aborted).toBe(true);
    hook.rerender({ queue: 'invoices', window: '7d' });
    expect(signals[2].aborted).toBe(true);
    for (const patch of [
      { baseUrl: 'http://other.test' },
      { agentBaseUrl: 'http://other-agent.test' },
      { token: 'changed' },
      { agentToken: 'changed-agent' },
    ]) {
      const previous = signals.length - 1;
      act(() => useConnectionStore.setState(patch));
      expect(signals[previous].aborted).toBe(true);
      expect(hook.result.current.view).toBeUndefined();
    }
    await act(async () => {
      finish.slice(2, -2).forEach((resolve) => resolve(response(888)));
      finish.at(-2)!(response(5));
      finish.at(-1)!(response(1));
    });
    expect(hook.result.current.view?.series.completed.total).toBe(5);
    act(() => hook.result.current.reload());
    expect(hook.result.current.view).toBeUndefined();
    const lastSignal = signals.at(-1)!;
    hook.unmount();
    mounted.delete(hook.unmount);
    expect(lastSignal.aborted).toBe(true);
    await act(async () => {
      finish.at(-2)!(response(9));
      finish.at(-1)!(response(9));
    });
  });

  test('surfaces a missing paired agent as unavailable instead of empty history', async () => {
    useConnectionStore.setState({ agentBaseUrl: '' });
    const hook = renderHook(() => useMetricHistory('orders', '1h'));
    mounted.add(hook.unmount);
    await settle(1);
    expect(hook.result.current.error).toContain('paired agent');
    expect(hook.result.current.view).toBeUndefined();
    expect(hook.result.current.loading).toBe(false);
  });
});
