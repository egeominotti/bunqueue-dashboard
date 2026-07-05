import { describe, expect, test } from 'bun:test';
import { frameIndicatesConnected, parseFrame, streamEvents } from '../src/lib/sse';

describe('parseFrame', () => {
  test('parses an event with JSON data', () => {
    const f = parseFrame('event: job:completed\ndata: {"jobId":"1","queue":"q"}');
    expect(f?.event).toBe('job:completed');
    expect((f?.data as { jobId: string }).jobId).toBe('1');
    expect((f?.data as { queue: string }).queue).toBe('q');
  });

  test('captures the id field', () => {
    const f = parseFrame('id: 42\nevent: job:active\ndata: {}');
    expect(f?.id).toBe('42');
    expect(f?.event).toBe('job:active');
  });

  test('comment-only / heartbeat frame → null', () => {
    expect(parseFrame(':heartbeat')).toBeNull();
  });

  test('defaults event to "message" and keeps non-JSON data as string', () => {
    const f = parseFrame('data: hello world');
    expect(f?.event).toBe('message');
    expect(f?.data).toBe('hello world');
  });

  test('joins multiple data lines', () => {
    const f = parseFrame('data: line1\ndata: line2');
    expect(f?.data).toBe('line1\nline2');
  });

  test('server handshake frame parses with event="message" and data.connected=true', () => {
    // The server sends `retry: 3000\ndata: {"connected":true,"clientId":"x"}`
    // with NO `event:` line, so the old useActivityStream check
    // `frame.event === 'connected'` never matched → the "connected" indicator
    // was stuck false on an idle queue. The signal lives in the data payload,
    // and any delivered frame means the stream is live.
    const f = parseFrame('retry: 3000\ndata: {"connected":true,"clientId":"abc"}');
    expect(f).not.toBeNull();
    expect(f?.event).toBe('message');
    expect((f?.data as { connected?: boolean }).connected).toBe(true);
  });
});

describe('frameIndicatesConnected', () => {
  // Guards the useActivityStream fix: connected must flip true on ANY delivered
  // frame, not only `event === 'connected'` (which the server never emits).
  // Reverting the predicate to the old event-gated check breaks these.
  test('the handshake frame (event="message") counts as connected', () => {
    const f = parseFrame('data: {"connected":true,"clientId":"x"}');
    expect(f).not.toBeNull();
    expect(frameIndicatesConnected(f as NonNullable<typeof f>)).toBe(true);
  });

  test('idle typed events and job events all count as connected', () => {
    for (const raw of [
      'event: stats:snapshot\ndata: {}',
      'event: health:status\ndata: {"ok":true}',
      'event: job:completed\ndata: {"jobId":"1","queue":"q"}',
    ]) {
      const f = parseFrame(raw);
      expect(f).not.toBeNull();
      expect(frameIndicatesConnected(f as NonNullable<typeof f>)).toBe(true);
    }
  });
});

describe('streamEvents frame boundaries', () => {
  function mockFetchOnce(body: string) {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    });
    const orig = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(new Response(stream, { status: 200 }))) as typeof fetch;
    return () => {
      globalThis.fetch = orig;
    };
  }

  test('splits on the EARLIEST boundary when \\r\\n\\r\\n precedes \\n\\n (no frame merge)', async () => {
    // Regression: a `indexOf('\\n\\n') || indexOf('\\r\\n\\r\\n')` short-circuit picked
    // the later \\n\\n over the earlier \\r\\n\\r\\n, gluing two events into one.
    const restore = mockFetchOnce('data: {"jobId":"1"}\r\n\r\ndata: {"jobId":"2"}\n\n');
    try {
      const ids: string[] = [];
      await streamEvents(
        '/events',
        (f) => ids.push((f.data as { jobId: string }).jobId),
        new AbortController().signal
      );
      expect(ids).toEqual(['1', '2']);
    } finally {
      restore();
    }
  });

  test('handles plain \\n\\n framing', async () => {
    const restore = mockFetchOnce('data: {"jobId":"a"}\n\ndata: {"jobId":"b"}\n\n');
    try {
      const ids: string[] = [];
      await streamEvents(
        '/events',
        (f) => ids.push((f.data as { jobId: string }).jobId),
        new AbortController().signal
      );
      expect(ids).toEqual(['a', 'b']);
    } finally {
      restore();
    }
  });
});
