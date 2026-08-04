import {
  describe,
  expect,
  installTestHooks,
  renderHook,
  settle,
  test,
  useActivityStream,
} from './async-ui-state-fixes.helpers';

installTestHooks();

describe('activity-stream target changes', () => {
  test('switching queue clears the previous queue throughput immediately', async () => {
    const encoder = new TextEncoder();
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controllers.push(controller);
              init?.signal?.addEventListener(
                'abort',
                () =>
                  controller.error(
                    init.signal?.reason ?? new DOMException('Aborted', 'AbortError')
                  ),
                { once: true }
              );
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } }
        )
      )) as typeof fetch;

    const renders: Array<ReturnType<typeof useActivityStream>> = [];
    const hook = renderHook((queue: string) => {
      const snapshot = useActivityStream(queue);
      renders.push({
        ...snapshot,
        events: [...snapshot.events],
        counters: { ...snapshot.counters },
      });
      return snapshot;
    }, 'queue-a');
    await settle(20);
    controllers[0]?.enqueue(
      encoder.encode('event: job:pushed\ndata: {"queue":"queue-a","jobId":"a"}\n\n')
    );
    await settle(1100);
    expect(hook.result.current.throughput).toBeGreaterThan(0);
    expect(hook.result.current.events).toHaveLength(1);
    expect(hook.result.current.counters.total).toBe(1);
    expect(hook.result.current.connected).toBe(true);

    controllers[0]?.error(new Error('old target stream failed'));
    await settle(20);
    expect(hook.result.current.error?.message).toContain('old target stream failed');

    const firstQueueBRender = renders.length;
    hook.rerender('queue-b');
    const transitional = renders[firstQueueBRender];
    expect(transitional).toBeDefined();
    expect(transitional.throughput).toBe(0);
    expect(transitional.events).toEqual([]);
    expect(transitional.counters).toEqual({
      total: 0,
      completed: 0,
      failed: 0,
      waiting: 0,
      active: 0,
    });
    expect(transitional.connected).toBe(false);
    expect(transitional.error).toBeNull();
    await settle(10);
    hook.unmount();
  }, 10000);
});
