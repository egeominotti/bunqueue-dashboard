import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { createMetricHistoryRepository } from '../src/features/metric-history/repository';

const realFetch = globalThis.fetch;
let originalConnection: ReturnType<typeof useConnectionStore.getState>;
const metrics = { meta: { count: 999, prevTS: 120001, prevCount: 2 }, data: [2, 0], count: 12 };

beforeEach(() => {
  originalConnection = useConnectionStore.getState();
  useConnectionStore.setState({
    baseUrl: 'http://queue-a.test',
    agentBaseUrl: 'http://agent-a.test',
    token: 'server-secret',
    agentToken: 'agent-secret',
  });
});
afterEach(() => {
  globalThis.fetch = realFetch;
  useConnectionStore.setState(originalConnection, true);
});

describe('target-pinned native history reads', () => {
  test('reads each type exactly once with an explicit inclusive seven-day range', async () => {
    const requests: Request[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return Response.json({ ok: true, metrics });
    }) as typeof fetch;
    const result = await createMetricHistoryRepository('orders.eu').read(
      '7d',
      new AbortController().signal
    );
    expect(result).toEqual({ completed: metrics, failed: metrics, errors: {} });
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => new URL(request.url).searchParams.get('type'))).toEqual([
      'completed',
      'failed',
    ]);
    for (const request of requests) {
      const url = new URL(request.url);
      expect(url.origin + url.pathname).toBe(
        'http://agent-a.test/queue-operations/orders.eu/metrics'
      );
      expect(Object.fromEntries(url.searchParams)).toMatchObject({
        target: 'http://queue-a.test',
        start: '0',
        end: '10079',
      });
      expect(request.headers.get('Authorization')).toBe('Bearer agent-secret');
      expect(request.url).not.toContain('secret');
    }
  });

  test('aborts in-flight reads for server, agent and either credential changes', async () => {
    for (const patch of [
      { baseUrl: 'http://queue-b.test' },
      { agentBaseUrl: 'http://agent-b.test' },
      { token: 'new-server-secret' },
      { agentToken: 'new-agent-secret' },
      { activeProfileId: 'other-profile' },
    ]) {
      useConnectionStore.setState({
        baseUrl: 'http://queue-a.test',
        agentBaseUrl: 'http://agent-a.test',
        token: 'server-secret',
        agentToken: 'agent-secret',
        activeProfileId: 'initial',
      });
      const signals: AbortSignal[] = [];
      const finish: Array<(value: Response) => void> = [];
      globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
        signals.push(init!.signal!);
        return new Promise<Response>((resolve) => finish.push(resolve));
      }) as typeof fetch;
      const pending = createMetricHistoryRepository('orders').read(
        '1h',
        new AbortController().signal
      );
      useConnectionStore.setState(patch);
      expect(signals).toHaveLength(2);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      finish.forEach((resolve) => resolve(Response.json({ ok: true, metrics })));
      await expect(pending).rejects.toThrow();
    }
  });

  test('rejects a captured target after changes and does not silently recapture it', async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      return Response.json({ ok: true, metrics });
    }) as typeof fetch;
    const repository = createMetricHistoryRepository('orders');
    useConnectionStore.setState({ token: 'rotated' });
    await expect(repository.read('24h', new AbortController().signal)).rejects.toThrow(
      'Connection changed'
    );
    expect(requests).toBe(0);
  });

  test('propagates stopped and mismatched-agent failures without fabricated buckets', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const type = new URL(String(input)).searchParams.get('type');
      return type === 'completed'
        ? Response.json({ ok: false, error: 'Start the managed Bunqueue server' }, { status: 503 })
        : Response.json({ ok: false, error: 'Managed target mismatch' }, { status: 409 });
    }) as typeof fetch;
    expect(
      await createMetricHistoryRepository('orders').read('1h', new AbortController().signal)
    ).toEqual({
      errors: { completed: 'Start the managed Bunqueue server', failed: 'Managed target mismatch' },
    });
  });

  test('preserves a successful type when the other response is malformed', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) =>
      Response.json(
        new URL(String(input)).searchParams.get('type') === 'completed'
          ? { ok: true, metrics }
          : { ok: true, metrics: { data: [3] } }
      )) as typeof fetch;
    expect(
      await createMetricHistoryRepository('orders').read('24h', new AbortController().signal)
    ).toEqual({
      completed: metrics,
      errors: { failed: 'Malformed Queue metrics response' },
    });
  });

  test('refuses a missing agent and invalid queues before making requests', () => {
    expect(() => createMetricHistoryRepository('../orders')).toThrow('Queue');
    useConnectionStore.setState({ agentBaseUrl: '' });
    expect(() => createMetricHistoryRepository('orders')).toThrow('paired agent');
  });
});
