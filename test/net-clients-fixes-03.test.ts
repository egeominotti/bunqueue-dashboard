import {
  describe,
  expect,
  installTestHooks,
  streamEvents,
  test,
} from './net-clients-fixes.helpers';

installTestHooks();

describe('streamEvents cleanup and liveness', () => {
  test('a failed connect cancels the unread response body', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    globalThis.fetch = (() =>
      Promise.resolve(new Response(stream, { status: 401 }))) as typeof fetch;
    await expect(streamEvents('/events', () => {}, new AbortController().signal)).rejects.toThrow(
      'SSE connect failed: HTTP 401'
    );
    expect(cancelled).toBe(true);
  });

  test('an ok response with no body reports the body, not a bogus "HTTP 200"', async () => {
    globalThis.fetch = (() => Promise.resolve(new Response(null, { status: 200 }))) as typeof fetch;
    await expect(streamEvents('/events', () => {}, new AbortController().signal)).rejects.toThrow(
      'SSE connect failed: empty response body'
    );
  });

  test('a silent (half-open) stream rejects on the idle deadline instead of hanging', async () => {
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          // Real fetch errors the body when the request signal aborts.
          init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), {
            once: true,
          });
        },
      });
      return Promise.resolve(
        new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      );
    }) as typeof fetch;
    await expect(
      streamEvents('/events', () => {}, new AbortController().signal, 10)
    ).rejects.toThrow('SSE idle timeout');
  });
});
