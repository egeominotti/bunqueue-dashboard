import { describe, expect, test } from 'bun:test';
import { jsonResponse, sseResponse } from '../src/lib/demo/responses';

describe('demo HTTP response primitives', () => {
  test('serializes JSON with the requested status and media type', async () => {
    const response = jsonResponse({ ok: false, error: 'demo failure' }, 418);
    expect(response.status).toBe(418);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ ok: false, error: 'demo failure' });
  });

  test('sends its handshake and closes immediately for an already-aborted caller', async () => {
    const controller = new AbortController();
    controller.abort();
    const response = sseResponse(controller.signal);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('SSE body missing');
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe('data: {"connected":true}\n\n');
    expect((await reader.read()).done).toBe(true);
  });

  test('emits a representative job frame and drains when aborted', async () => {
    const controller = new AbortController();
    const reader = sseResponse(controller.signal).body?.getReader();
    if (!reader) throw new Error('SSE body missing');
    await reader.read();
    const event = await reader.read();
    const frame = new TextDecoder().decode(event.value);
    expect(frame).toContain('event: job:active');
    expect(frame).toContain('"queue":"emails"');
    expect(frame).toContain('"jobId":"demo-0"');
    controller.abort();
    expect((await reader.read()).done).toBe(true);
  });
});
