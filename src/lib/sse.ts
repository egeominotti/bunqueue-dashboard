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

/** Connect/response failure with the HTTP status preserved for retry policy. */
export class SseConnectError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly lastEventIdSent = false
  ) {
    super(message);
    this.name = 'SseConnectError';
  }
}

const LAST_EVENT_ID_REJECTION_STATUSES = new Set([400, 409, 413, 431]);

/**
 * Whether a frame-less HTTP response plausibly rejected Last-Event-ID itself.
 * Authentication, server failures, and transport errors must retain the
 * checkpoint so a transient outage does not silently create a replay gap.
 */
export function shouldDiscardLastEventId(error: unknown): boolean {
  return (
    error instanceof SseConnectError &&
    error.lastEventIdSent &&
    LAST_EVENT_ID_REJECTION_STATUSES.has(error.status)
  );
}

/**
 * Event IDs are later copied into an HTTP header. Real server IDs are tiny
 * (usually counters/UUIDs); 4 KiB leaves ample protocol headroom while avoiding
 * an unbounded reconnect header and common proxy header-size limits.
 */
export const SSE_MAX_EVENT_ID_CHARS = 4096;

function usableEventId(value: string): boolean {
  // The event-stream spec requires an `id` field containing U+0000 to be
  // ignored. Oversized IDs are likewise ignored, but never invalidate the data
  // event that carried them.
  return !value.includes('\0') && value.length <= SSE_MAX_EVENT_ID_CHARS;
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
    else if (field === 'id' && usableEventId(value)) id = value;
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
 * Maximum UTF-16 length of one not-yet-dispatched SSE frame. Queue events are
 * tiny; this generous ceiling prevents a peer that never sends a blank-line
 * delimiter (or sends one enormous event) from growing `buffer` without bound.
 */
export const SSE_MAX_FRAME_CHARS = 256 * 1024;

/**
 * Consume an SSE endpoint until `signal` aborts. Calls `onFrame` for each event.
 * Resolves when the stream ends; rejects on network error (unless aborted), and
 * on `idleMs` without a single byte so the caller can reconnect.
 */
export async function streamEvents(
  url: string,
  onFrame: (frame: SseFrame) => void,
  signal: AbortSignal,
  idleMs: number = SSE_IDLE_MS,
  lastEventId?: string
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
    const headers = new Headers({ Accept: 'text/event-stream', ...getAuthHeaders() });
    let lastEventIdSent = false;
    if (lastEventId && usableEventId(lastEventId)) {
      // A caller can supply an ID directly instead of obtaining it from
      // parseFrame. If the platform rejects another control/non-ByteString
      // character, omit replay for this attempt instead of making every future
      // reconnect throw before fetch is even reached.
      try {
        headers.set('Last-Event-ID', lastEventId);
        lastEventIdSent = true;
      } catch {
        headers.delete('Last-Event-ID');
      }
    }
    const res = await fetch(url, {
      headers,
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) {
      // Cancel the unread body: the caller reconnects every couple of seconds on
      // a persistent failure (401/404/502), and abandoning a Response per attempt
      // pins its socket and buffers until GC.
      await res.body?.cancel().catch(() => {});
      throw new SseConnectError(
        res.ok
          ? 'SSE connect failed: empty response body'
          : `SSE connect failed: HTTP ${res.status}`,
        res.status,
        lastEventIdSent
      );
    }

    // A reverse proxy can return a successful HTML/JSON login or error page.
    // Treating that payload as SSE leaves the UI in a misleading reconnecting
    // state (and may even parse an accidental `data:` line). Per the SSE
    // protocol, a usable stream must explicitly advertise text/event-stream.
    const contentType = res.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== 'text/event-stream') {
      await res.body.cancel().catch(() => {});
      throw new SseConnectError(
        `SSE connect failed: expected text/event-stream, received ${contentType || 'no Content-Type'}`,
        res.status,
        lastEventIdSent
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
            if (buffer.length > SSE_MAX_FRAME_CHARS) {
              throw new Error(`SSE frame exceeds the ${SSE_MAX_FRAME_CHARS}-character limit`);
            }
            break;
          }
          // Check before slicing/parsing so a delimited oversized frame cannot
          // evade the incomplete-buffer cap merely by appending `\n\n`.
          if (sep > SSE_MAX_FRAME_CHARS) {
            throw new Error(`SSE frame exceeds the ${SSE_MAX_FRAME_CHARS}-character limit`);
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
