/**
 * Minimal SSE reader built on fetch + ReadableStream.
 *
 * Why not EventSource? EventSource cannot send an Authorization header, so it
 * breaks against a bunqueue server with AUTH_TOKENS set. This reader streams the
 * response body and parses SSE frames manually, so it works with a bearer token
 * and through the Vite dev proxy.
 */
import { getAuthHeaders } from '@/components/dashboard/stores/connectionStore';

export interface SseFrame {
  id?: string;
  event: string;
  data: unknown;
}

/**
 * Whether a delivered frame proves the SSE link is live. ANY parsed frame does:
 * the server's handshake sets `data.connected` with the event defaulting to
 * `'message'` (no `event:` line), and periodic typed events (`stats:snapshot`,
 * `health:status`, …) plus `job:*` events all arrive on a live stream. The old
 * code gated "connected" on `frame.event === 'connected'` — an event the server
 * never emits — so an idle queue showed "Connecting…" forever. Heartbeats and
 * comments return `null` from `parseFrame` and never reach here.
 */
export function frameIndicatesConnected(_frame: SseFrame): boolean {
  return true;
}

export function parseFrame(raw: string): SseFrame | null {
  let event = 'message';
  let id: string | undefined;
  const dataLines: string[] = [];

  for (const line of raw.split('\n')) {
    if (!line || line.startsWith(':')) continue; // comment / heartbeat
    const idx = line.indexOf(':');
    const field = idx === -1 ? line : line.slice(0, idx);
    const value = idx === -1 ? '' : line.slice(idx + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
    else if (field === 'id') id = value;
  }

  if (dataLines.length === 0) return null;
  const dataStr = dataLines.join('\n');
  let data: unknown = dataStr;
  try {
    data = JSON.parse(dataStr);
  } catch {
    /* keep as string */
  }
  return { id, event, data };
}

/**
 * Consume an SSE endpoint until `signal` aborts. Calls `onFrame` for each event.
 * Resolves when the stream ends; rejects on network error (unless aborted).
 */
export async function streamEvents(
  url: string,
  onFrame: (frame: SseFrame) => void,
  signal: AbortSignal
): Promise<void> {
  const res = await fetch(url, {
    headers: { Accept: 'text/event-stream', ...getAuthHeaders() },
    signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`SSE connect failed: HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Frames are separated by a blank line (\n\n). Tolerate \r\n too. Take the
      // EARLIEST boundary each pass — a naive `\n\n || \r\n\r\n` short-circuit
      // could pick a later \n\n over an earlier \r\n\r\n and merge two frames.
      while (true) {
        const lf = buffer.indexOf('\n\n');
        const crlf = buffer.indexOf('\r\n\r\n');
        let sep: number;
        let width: number;
        if (lf !== -1 && (crlf === -1 || lf <= crlf)) {
          sep = lf;
          width = 2;
        } else if (crlf !== -1) {
          sep = crlf;
          width = 4;
        } else {
          break;
        }
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + width);
        const frame = parseFrame(raw.replace(/\r/g, ''));
        if (frame) onFrame(frame);
      }
    }
  } finally {
    reader.releaseLock();
  }
}
