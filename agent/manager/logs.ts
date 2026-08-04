import type { LogLine } from './types';

const MAX_LOGS = 800;
const MAX_LINE = 8192;

interface CancelablePipeReader {
  cancel(reason?: unknown): Promise<void>;
}

export class ProcessLogs {
  private lines: LogLine[] = [];
  private sequence = 0;
  private readers = new Map<number, Set<CancelablePipeReader>>();

  get(): LogLine[] {
    return this.lines;
  }

  push(stream: LogLine['stream'], line: string): void {
    const capped = line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…[truncated]` : line;
    this.lines.push({ seq: this.sequence++, ts: Date.now(), stream, line: capped });
    if (this.lines.length > MAX_LOGS + 256) {
      this.lines.splice(0, this.lines.length - MAX_LOGS);
    }
  }

  cancel(token: number): void {
    const active = this.readers.get(token);
    if (!active) return;
    this.readers.delete(token);
    for (const reader of active) {
      void reader.cancel('process generation ended').catch(() => undefined);
    }
  }

  async capture(
    stream: ReadableStream<Uint8Array>,
    name: 'stdout' | 'stderr',
    token: number,
    isCurrent: () => boolean
  ): Promise<void> {
    const reader = stream.getReader();
    let active = this.readers.get(token);
    if (!active) {
      active = new Set();
      this.readers.set(token, active);
    }
    active.add(reader);
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (!isCurrent()) return;
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let newline: number;
          while ((newline = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            if (line.trim() && isCurrent()) this.push(name, line);
          }
          while (buffer.length > MAX_LINE) {
            if (!isCurrent()) return;
            this.push(name, buffer.slice(0, MAX_LINE));
            buffer = buffer.slice(MAX_LINE);
          }
        }
      } catch {
        // Stream closed or explicitly cancelled.
      }
      if (!isCurrent()) return;
      const tail = buffer + decoder.decode();
      if (tail.trim() && isCurrent()) this.push(name, tail);
    } finally {
      const current = this.readers.get(token);
      current?.delete(reader);
      if (current?.size === 0) this.readers.delete(token);
      reader.releaseLock();
    }
  }
}
