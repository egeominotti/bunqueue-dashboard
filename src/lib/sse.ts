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
 * Idle deadline: a half-open socket (laptop sleep, Wi-Fi→LTE handoff, an
 * idle-timeout NAT) delivers neither bytes nor FIN/RST, so `reader.read()` would
 * hang forever and the caller's reconnect loop — which waits for streamEvents to
 * settle — would never run while the UI still claims "Live". Anything materially
 * longer than the server's heartbeat period means the link is dead.
 */
export const SSE_IDLE_MS = 45_000;

/**
 * Consume an SSE endpoint until `signal` aborts. Calls `onFrame` for each event.
 * Resolves when the stream ends; rejects on network error (unless aborted), and
 * on `idleMs` without a single byte so the caller can reconnect.
 */
export async function streamEvents(
  url: string,
  onFrame: (frame: SseFrame) => void,
  signal: AbortSignal,
  idleMs: number = SSE_IDLE_MS
): Promise<void> {
  // Local controller = caller teardown OR idle deadline. Aborting it in the
  // finally also closes the connection if the loop exits abnormally.
  const ctrl = new AbortController();
  const onOuterAbort = () => ctrl.abort(signal.reason);
  if (signal.aborted) ctrl.abort(signal.reason);
  else signal.addEventListener('abort', onOuterAbort, { once: true });
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => ctrl.abort(new Error('SSE idle timeout')), idleMs);
  };

  try {
    armIdle();
    const res = await fetch(url, {
      headers: { Accept: 'text/event-stream', ...getAuthHeaders() },
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) {
      // Cancel the unread body: the caller reconnects every couple of seconds on
      // a persistent failure (401/404/502), and abandoning a Response per attempt
      // pins its socket and buffers until GC.
      await res.body?.cancel().catch(() => {});
      throw new Error(
        res.ok
          ? 'SSE connect failed: empty response body'
          : `SSE connect failed: HTTP ${res.status}`
      );
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        armIdle(); // bytes arrived — restart the idle deadline
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
  } finally {
    clearTimeout(idleTimer);
    signal.removeEventListener('abort', onOuterAbort);
    ctrl.abort(); // no-op once the body is drained; closes it on an abnormal exit
  }
}
