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
const jobFrame = (event: string, data: Record<string, unknown>) =>
  push(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

beforeEach(() => {
  controllers = [];
  fetchCalls = 0;
  globalThis.fetch = (() => {
    fetchCalls += 1;
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

  test('reconnects after a clean stream end (server restart) and re-flags connected', async () => {
    const h = renderHook(() => useActivityStream());
    await settle(5);
    handshake();
    await settle(5);
    expect(h.result.current.connected).toBe(true);

    controllers.at(-1)?.close(); // clean end, e.g. server restarting
    await settle(50);
    expect(h.result.current.connected).toBe(false);

    await settle(2500); // reconnect backoff is 2s; generous slack for a starved CI runner
    expect(fetchCalls).toBe(2);
    handshake();
    await settle(5);
    expect(h.result.current.connected).toBe(true);
    h.unmount();
  }, 10000);
});
