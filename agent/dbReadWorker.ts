import { dispatchRead } from './db/readOperations';
import { MissingDbError } from './db/types';

declare const self: Worker;

// Runs inside a disposable PROCESS. Its supervisor remains responsive to stdin
// closing when the agent dies, even while this thread is in sqlite3_step.
self.addEventListener('message', (event: MessageEvent) => {
  try {
    const result = dispatchRead(event.data);
    const content = result && typeof result === 'object' && 'content' in result ? result.content : null;
    self.postMessage({ ok: true, result }, content instanceof Uint8Array && content.buffer instanceof ArrayBuffer ? [content.buffer] : []);
  } catch (error) {
    self.postMessage({ ok: false,
      error: error instanceof Error ? error.message : 'Database read failed',
      missing: error instanceof MissingDbError,
    });
  }
});
