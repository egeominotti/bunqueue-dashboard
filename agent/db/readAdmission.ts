import { DbReadBusyError, DbReadUnavailableError, MAX_CONCURRENT_QUERIES } from './types';

type Release = () => void;
interface Waiter { admit(): void; cancel(error: unknown): void }
const MAX_PENDING_READS = 32;

/** Fair, bounded admission absorbs a page's parallel polls without spawning more SQLite processes. */
export class ReadAdmission {
  private active = 0;
  private waiting: Waiter[] = [];
  get load(): number { return this.active; }
  get pending(): number { return this.waiting.length; }

  acquire(queue: boolean, deadline: number, signal?: AbortSignal): Release | Promise<Release> {
    signal?.throwIfAborted();
    if (this.active < MAX_CONCURRENT_QUERIES) return this.reserve();
    if (!queue || this.waiting.length >= MAX_PENDING_READS) {
      throw new DbReadBusyError(`Too many queries running (${this.active}/${MAX_CONCURRENT_QUERIES}). Retry after a current read finishes.`);
    }
    return new Promise<Release>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const index = this.waiting.indexOf(waiter);
        if (index !== -1) this.waiting.splice(index, 1);
      };
      const waiter: Waiter = {
        admit: () => { if (!settled) { cleanup(); resolve(this.reserve()); } },
        cancel: (error) => { if (!settled) { cleanup(); reject(error); } },
      };
      const onAbort = () => waiter.cancel(signal?.reason instanceof Error ? signal.reason : new Error('Database read aborted'));
      const timer = setTimeout(() => waiter.cancel(new DbReadUnavailableError(
        'Database read exceeded the time limit while waiting for capacity'
      )), Math.max(1, deadline - performance.now()));
      this.waiting.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  private reserve(): Release {
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.waiting[0]?.admit();
    };
  }
}
