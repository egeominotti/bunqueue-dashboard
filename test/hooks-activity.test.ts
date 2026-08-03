import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { useActivityStream } from '../src/lib/useActivityStream';
import { renderHook, settle } from './domSetup';

// Drives useActivityStream end-to-end through the REAL sse.ts parser: a mocked
// fetch hands back a ReadableStream we push SSE frames into, so these tests
// cover frame parsing, the connected flag, event buffering/ordering through the
// 150ms flush timer, counter mapping, the 250-event ring cap, and reconnect.

const encoder = new TextEncoder();

let controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
let fetchCalls = 0;
let requestHeaders: Headers[] = [];
const realFetch = globalThis.fetch;

function sseResponse(): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controllers.push(c);
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

/** Push one SSE frame into the most recent stream. */
function push(frame: string): void {
  controllers.at(-1)?.enqueue(encoder.encode(frame));
}

const handshake = () => push('data: {"connected":true}\n\n');
const jobFrame = (event: string, data: Record<string, unknown>, id?: string) =>
  push(`${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

beforeEach(() => {
  controllers = [];
  fetchCalls = 0;
  requestHeaders = [];
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls += 1;
    requestHeaders.push(new Headers(init?.headers));
    return Promise.resolve(sseResponse());
  }) as typeof fetch;
  useConnectionStore.setState({ baseUrl: 'http://srv', token: '' });
});

afterEach(() => {
  // End any live stream so no reader is left waiting across tests.
  for (const c of controllers) {
    try {
      c.close();
    } catch {
      /* already closed */
    }
  }
  globalThis.fetch = realFetch;
  useConnectionStore.setState({ baseUrl: '/api', token: '' });
});

describe('useActivityStream', () => {
  test('connects on the handshake frame and buffers job events newest-first', async () => {
    const h = renderHook(() => useActivityStream());
    expect(h.result.current.connected).toBe(false);

    await settle(5);
    handshake();
    await settle(5);
    expect(h.result.current.connected).toBe(true);
    expect(fetchCalls).toBe(1);

    jobFrame('job:pushed', { queue: 'q1', jobId: 'a' });
    jobFrame('job:pulled', { queue: 'q1', jobId: 'a' });
    jobFrame('job:completed', { queue: 'q1', jobId: 'a' });
    await settle(200); // > the 150ms flush timer

    const events = h.result.current.events;
    expect(events.map((e) => e.event)).toEqual(['job:completed', 'job:pulled', 'job:pushed']);
    // statusFromEvent mapping: pushed→waiting, pulled→active, completed→completed.
    expect(events.map((e) => e.status)).toEqual(['completed', 'active', 'waiting']);
    expect(h.result.current.counters).toEqual({
      total: 3,
      completed: 1,
      failed: 0,
      waiting: 1,
      active: 1,
    });
    h.unmount();
  });

  test('non-job frames flip connected but never enter the event buffer', async () => {
    const h = renderHook(() => useActivityStream());
    await settle(5);
    push('event: stats:snapshot\ndata: {"depth":4}\n\n');
    await settle(200);
    expect(h.result.current.connected).toBe(true);
    expect(h.result.current.events).toEqual([]);
    expect(h.result.current.counters.total).toBe(0);
    h.unmount();
  });

  test('ring buffer caps at 250 events', async () => {
    const h = renderHook(() => useActivityStream());
    await settle(5);
    for (let i = 0; i < 260; i++) {
      jobFrame('job:pushed', { queue: 'q1', jobId: `j${i}` });
    }
    await settle(250);
    expect(h.result.current.events.length).toBe(250);
    // Newest kept: the last pushed job is at the head, the first 10 dropped.
    expect(h.result.current.events[0]?.jobId).toBe('j259');
    expect(h.result.current.counters.total).toBe(260);
    h.unmount();
  });

  test('normalizes untrusted job payload fields and always publishes a finite timestamp', async () => {
    const realNow = Date.now;
    Date.now = () => 12_345;
    try {
      const h = renderHook(() => useActivityStream());
      await settle(5);
      push(
        'event: job:progress\ndata: {"queue":7,"jobId":{},"name":false,"timestamp":"soon","error":["bad"],"progress":"50"}\n\n'
      );
      push('event: job:completed\ndata: null\n\n');
      push(
        'event: job:progress\ndata: {"queue":"valid-q","jobId":"valid-id","name":"valid-name","timestamp":9876,"error":"valid-error","progress":50}\n\n'
      );
      push(
        `event: job:failed\ndata: ${JSON.stringify({
          queue: 'q'.repeat(257),
          jobId: 'j'.repeat(1025),
          name: 'n'.repeat(513),
          timestamp: 9e99,
          error: 'e'.repeat(4097),
        })}\n\n`
      );
      await settle(200);

      expect(h.result.current.events).toHaveLength(4);
      expect(h.result.current.events[1]).toMatchObject({
        queue: 'valid-q',
        jobId: 'valid-id',
        name: 'valid-name',
        timestamp: 9876,
        error: 'valid-error',
        progress: 50,
      });
      for (const event of [h.result.current.events[0], ...h.result.current.events.slice(2)]) {
        expect(Number.isFinite(event.timestamp)).toBe(true);
        expect(event.timestamp).toBe(12_345);
        expect(event.queue).toBeUndefined();
        expect(event.jobId).toBeUndefined();
        expect(event.name).toBeUndefined();
        expect(event.error).toBeUndefined();
        expect(event.progress).toBeUndefined();
      }
      h.unmount();
    } finally {
      Date.now = realNow;
    }
  });

  test('drops buffered and late frames from the obsolete queue generation', async () => {
    const h = renderHook((selected: string) => useActivityStream(selected), 'queue-a');
    await settle(5);
    expect(controllers).toHaveLength(1);

    // Parsed into queue-a's pending batch but switch before its 150ms flush.
    controllers[0]?.enqueue(
      encoder.encode('event: job:pushed\ndata: {"queue":"queue-a","jobId":"buffered"}\n\n')
    );
    await settle(5);

    h.rerender('queue-b');
    await settle(5);
    expect(controllers).toHaveLength(2);

    // The mock ReadableStream is deliberately not wired to fetch's signal, so
    // controller 0 can still deliver after queue-a's AbortController fired.
    controllers[0]?.enqueue(
      encoder.encode('event: job:failed\ndata: {"queue":"queue-a","jobId":"stale"}\n\n')
    );
    await settle(200);
    expect(h.result.current.connected).toBe(false);
    expect(h.result.current.events).toEqual([]);
    expect(h.result.current.counters.total).toBe(0);

    controllers[1]?.enqueue(encoder.encode('data: {"connected":true}\n\n'));
    controllers[1]?.enqueue(
      encoder.encode('event: job:pushed\ndata: {"queue":"queue-b","jobId":"current"}\n\n')
    );
    await settle(200);
    expect(h.result.current.connected).toBe(true);
    expect(h.result.current.events.map((event) => event.jobId)).toEqual(['current']);
    expect(h.result.current.counters.total).toBe(1);
    h.unmount();
  });

  test('reconnects after a clean stream end (server restart) and re-flags connected', async () => {
    const h = renderHook(() => useActivityStream());
    await settle(5);
    handshake();
    jobFrame('job:pushed', { queue: 'q1', jobId: 'before-reconnect' }, 'event-17');
    await settle(5);
    expect(h.result.current.connected).toBe(true);

    controllers.at(-1)?.close(); // clean end, e.g. server restarting
    await settle(50);
    expect(h.result.current.connected).toBe(false);

    await settle(2500); // reconnect backoff is 2s; generous slack for a starved CI runner
    expect(fetchCalls).toBe(2);
    expect(requestHeaders[0]?.get('Last-Event-ID')).toBeNull();
    expect(requestHeaders[1]?.get('Last-Event-ID')).toBe('event-17');
    handshake();
    await settle(5);
    expect(h.result.current.connected).toBe(true);
    h.unmount();
  }, 10000);

  test('drops a replay id after one frame-less 431 rejection', async () => {
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls += 1;
      requestHeaders.push(new Headers(init?.headers));
      if (fetchCalls === 2) {
        return Promise.resolve(Response.json({ error: 'replay rejected' }, { status: 431 }));
      }
      return Promise.resolve(sseResponse());
    }) as typeof fetch;

    const h = renderHook(() => useActivityStream());
    await settle(5);
    handshake();
    jobFrame('job:pushed', { queue: 'q1', jobId: 'checkpoint' }, 'event-too-old');
    await settle(5);
    controllers.at(-1)?.close();

    await settle(2500);
    expect(fetchCalls).toBe(2);
    expect(requestHeaders[1]?.get('Last-Event-ID')).toBe('event-too-old');

    // The replay-bearing request produced no frame, so the following attempt
    // must recover without repeating a permanently rejected header.
    await settle(2500);
    expect(fetchCalls).toBe(3);
    expect(requestHeaders[2]?.get('Last-Event-ID')).toBeNull();
    handshake();
    await settle(5);
    expect(h.result.current.connected).toBe(true);
    expect(h.result.current.error).toBeNull();
    h.unmount();
  }, 10000);

  test('keeps a replay id through a transient frame-less 503 failure', async () => {
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls += 1;
      requestHeaders.push(new Headers(init?.headers));
      if (fetchCalls === 2) {
        return Promise.resolve(Response.json({ error: 'temporarily down' }, { status: 503 }));
      }
      return Promise.resolve(sseResponse());
    }) as typeof fetch;

    const h = renderHook(() => useActivityStream());
    await settle(5);
    handshake();
    jobFrame('job:pushed', { queue: 'q1', jobId: 'checkpoint' }, 'event-keep-me');
    await settle(5);
    controllers.at(-1)?.close();

    await settle(2500);
    expect(fetchCalls).toBe(2);
    expect(requestHeaders[1]?.get('Last-Event-ID')).toBe('event-keep-me');

    await settle(2500);
    expect(fetchCalls).toBe(3);
    expect(requestHeaders[2]?.get('Last-Event-ID')).toBe('event-keep-me');
    handshake();
    await settle(5);
    expect(h.result.current.connected).toBe(true);
    expect(h.result.current.error).toBeNull();
    h.unmount();
  }, 10000);
});
