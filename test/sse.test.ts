import { describe, expect, test } from 'bun:test';
import {
  frameIndicatesConnected,
  parseFrame,
  SSE_MAX_EVENT_ID_CHARS,
  SSE_MAX_FRAME_CHARS,
  SseConnectError,
  type SseFrame,
  shouldDiscardLastEventId,
  streamEvents,
} from '../src/lib/sse';

describe('parseFrame', () => {
  test('parses an event with JSON data', () => {
    const f = parseFrame('event: job:completed\ndata: {"jobId":"1","queue":"q"}');
    expect(f?.event).toBe('job:completed');
    if (!f) throw new Error('Expected a parsed SSE frame');
    expect((f.data as { jobId: string }).jobId).toBe('1');
    expect((f.data as { queue: string }).queue).toBe('q');
  });

  test('captures the id field', () => {
    const f = parseFrame('id: 42\nevent: job:active\ndata: {}');
    expect(f?.id).toBe('42');
    expect(f?.event).toBe('job:active');
  });

  test('ignores NUL-bearing and oversized id fields without dropping valid event data', () => {
    const nul = parseFrame('id: poisoned\0id\nevent: job:active\ndata: {"jobId":"nul"}');
    expect(nul).toMatchObject({ event: 'job:active', data: { jobId: 'nul' } });
    expect(nul?.id).toBeUndefined();

    const oversized = parseFrame(
      `id: ${'x'.repeat(SSE_MAX_EVENT_ID_CHARS + 1)}\nevent: job:active\ndata: {"jobId":"large"}`
    );
    expect(oversized).toMatchObject({ event: 'job:active', data: { jobId: 'large' } });
    expect(oversized?.id).toBeUndefined();
  });

  test('an invalid id field does not overwrite an earlier valid id in the same frame', () => {
    const f = parseFrame('id: safe-42\nid: ignored\0tail\ndata: {}');
    expect(f?.id).toBe('safe-42');
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
    if (!f) throw new Error('Expected a parsed SSE handshake');
    expect((f.data as { connected?: boolean }).connected).toBe(true);
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

describe('Last-Event-ID retry policy', () => {
  test('only explicit replay/header rejection statuses discard the checkpoint', () => {
    for (const status of [400, 409, 413, 431]) {
      expect(shouldDiscardLastEventId(new SseConnectError('rejected', status, true))).toBe(true);
    }
    for (const status of [200, 401, 403, 408, 429, 500, 502, 503]) {
      expect(shouldDiscardLastEventId(new SseConnectError('unrelated', status, true))).toBe(false);
    }
    expect(shouldDiscardLastEventId(new SseConnectError('no replay header', 431))).toBe(false);
    expect(shouldDiscardLastEventId(new TypeError('network offline'))).toBe(false);
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
      Promise.resolve(
        new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      )) as typeof fetch;
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

  test('rejects an unterminated frame once the pending buffer exceeds its bound', async () => {
    const restore = mockFetchOnce(`data: ${'x'.repeat(SSE_MAX_FRAME_CHARS)}`);
    try {
      const frames: SseFrame[] = [];
      await expect(
        streamEvents('/events', (frame) => frames.push(frame), new AbortController().signal)
      ).rejects.toThrow(`${SSE_MAX_FRAME_CHARS}-character limit`);
      expect(frames).toEqual([]);
    } finally {
      restore();
    }
  });

  test('rejects a delimited oversized frame before parsing or dispatching it', async () => {
    const restore = mockFetchOnce(`data: ${'x'.repeat(SSE_MAX_FRAME_CHARS)}\n\n`);
    try {
      const frames: SseFrame[] = [];
      await expect(
        streamEvents('/events', (frame) => frames.push(frame), new AbortController().signal)
      ).rejects.toThrow(`${SSE_MAX_FRAME_CHARS}-character limit`);
      expect(frames).toEqual([]);
    } finally {
      restore();
    }
  });

  test('rejects a successful non-SSE response before parsing its body', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response('data: {"jobId":"should-not-parse"}\n\n', {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        })
      )) as typeof fetch;
    try {
      const frames: SseFrame[] = [];
      await expect(
        streamEvents('/events', (frame) => frames.push(frame), new AbortController().signal)
      ).rejects.toThrow('expected text/event-stream, received application/json');
      expect(frames).toEqual([]);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test('sends Last-Event-ID when reconnecting through the authenticated fetch reader', async () => {
    const orig = globalThis.fetch;
    let headers = new Headers();
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      headers = new Headers(init?.headers);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      });
      return Promise.resolve(
        new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      );
    }) as typeof fetch;
    try {
      await streamEvents('/events', () => {}, new AbortController().signal, undefined, 'event-42');
      expect(headers.get('Last-Event-ID')).toBe('event-42');
      expect(headers.get('Accept')).toBe('text/event-stream');
    } finally {
      globalThis.fetch = orig;
    }
  });

  test('omits unsafe direct Last-Event-ID values instead of failing before fetch', async () => {
    const orig = globalThis.fetch;
    const seen: Headers[] = [];
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return Promise.resolve(
        new Response(new ReadableStream({ start: (controller) => controller.close() }), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      );
    }) as typeof fetch;
    try {
      await streamEvents('/events', () => {}, new AbortController().signal, undefined, 'bad\0id');
      await streamEvents(
        '/events',
        () => {},
        new AbortController().signal,
        undefined,
        'x'.repeat(SSE_MAX_EVENT_ID_CHARS + 1)
      );
      expect(seen).toHaveLength(2);
      expect(seen.every((headers) => headers.get('Last-Event-ID') === null)).toBe(true);
    } finally {
      globalThis.fetch = orig;
    }
  });
});
