import type { Json } from './shared';

export const jsonResponse = (body: Json, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/** An open SSE stream with a handshake and representative job events. */
export function sseResponse(signal?: AbortSignal | null): Response {
  const encoder = new TextEncoder();
  const queues = ['emails', 'image-processing', 'reports', 'notifications'];
  const kinds = [
    'job:active',
    'job:completed',
    'job:completed',
    'job:waiting',
    'job:failed',
    'job:active',
  ];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let index = 0;
      let closed = false;
      let timer: ReturnType<typeof setInterval>;
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        try {
          controller.close();
        } catch {
          // The reader may already have closed the controller.
        }
      };
      controller.enqueue(encoder.encode('data: {"connected":true}\n\n'));
      timer = setInterval(() => {
        if (closed) return;
        const kind = kinds[index % kinds.length];
        const queue = queues[index % queues.length];
        const data = JSON.stringify({
          queue,
          jobId: `demo-${index}`,
          name: queue,
          timestamp: Date.now(),
        });
        try {
          controller.enqueue(encoder.encode(`event: ${kind}\ndata: ${data}\n\n`));
        } catch {
          close();
        }
        index += 1;
      }, 1400);
      if (signal?.aborted) close();
      else signal?.addEventListener('abort', close, { once: true });
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}
