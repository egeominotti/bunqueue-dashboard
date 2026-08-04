import { fileURLToPath } from 'node:url';
import type { BackupOperation } from './runner';

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export async function executeBackupProcess(
  environment: Record<string, string>,
  operation: BackupOperation,
  key: string | undefined,
  signal: AbortSignal
): Promise<unknown> {
  signal.throwIfAborted();
  const bun = Bun.which('bun');
  if (!bun) throw new Error('The Bun executable is required to run Bunqueue backup commands');
  const child = Bun.spawn(
    [
      bun,
      bunqueueCliPath(),
      '--json',
      'backup',
      operation,
      ...(operation === 'restore' ? [key as string, '--force'] : []),
    ],
    { env: environment, stdout: 'pipe', stderr: 'pipe' }
  );
  const abort = () => child.kill('SIGKILL');
  signal.addEventListener('abort', abort, { once: true });
  try {
    let stdout: string;
    let stderr: string;
    let exitCode: number;
    try {
      [stdout, stderr, exitCode] = await Promise.all([
        readBounded(child.stdout),
        readBounded(child.stderr),
        child.exited,
      ]);
    } catch (error) {
      child.kill('SIGKILL');
      await child.exited;
      throw error;
    }
    if (signal.aborted) throw abortReason(signal);
    const raw = stdout.trim() || stderr.trim();
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error(
        exitCode === 0
          ? 'Bunqueue backup command returned malformed JSON'
          : `Bunqueue backup command failed with exit code ${exitCode}`
      );
    }
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

function bunqueueCliPath(): string {
  const main = import.meta.resolve('bunqueue');
  return fileURLToPath(new URL('./cli/index.js', main));
}

async function readBounded(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_OUTPUT_BYTES) throw new Error('Bunqueue backup command output exceeded 2 MiB');
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(output);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Backup operation cancelled');
}
