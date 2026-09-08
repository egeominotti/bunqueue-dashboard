import { deserialize, serialize } from 'node:v8';
import { compiledWorkerUrl } from '../compiledRuntime';

/** One request, one readonly connection, one process. Also bundled into the standalone server. */
export async function runDatabaseReadProcess(): Promise<void> {
  let response: unknown;
  let worker: Worker | undefined;
  try {
    const reader = Bun.stdin.stream().getReader();
    const input = deserialize(await readRequest(reader));
    // Parent keeps this pipe open. EOF also covers SIGKILL/TerminateProcess,
    // where the agent cannot run signal handlers or its ordinary exit hook.
    void reader.read().then(() => process.exit(1), () => process.exit(1));
    worker = new Worker(compiledWorkerUrl(import.meta.url, 'agent/dbReadWorker.js')
      ?? new URL('../dbReadWorker.ts', import.meta.url).href, { type: 'module' });
    response = await new Promise<unknown>((resolve, reject) => {
      worker!.addEventListener('message', (event: MessageEvent) => resolve(event.data));
      worker!.addEventListener('error', (event: ErrorEvent) => {
        event.preventDefault?.();
        reject(new Error(event.message || 'Database worker failed'));
      });
      worker!.postMessage(input);
    });
  } catch (error) {
    response = {
      ok: false,
      error: error instanceof Error ? error.message : 'Database read failed',
    };
  }
  const output = serialize(response);
  await Bun.write(Bun.stdout, output.byteLength <= 32 * 1024 * 1024
    ? output
    : serialize({ ok: false, error: 'Database result exceeded 32 MiB' }));
  // Exit the whole process, including its SQLite thread and liveness reader.
  worker?.terminate();
  process.exit(0);
}

async function readRequest(reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> }): Promise<Buffer> {
  let buffer = Buffer.alloc(0);
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done || !chunk.value) throw new Error('Truncated database request');
    if (buffer.byteLength + chunk.value.byteLength > 128 * 1024 + 4) throw new Error('Database request exceeds 128 KiB');
    buffer = Buffer.concat([buffer, chunk.value]);
    if (buffer.byteLength < 4) continue;
    const length = buffer.readUInt32LE(0);
    if (length > 128 * 1024) throw new Error('Database request exceeds 128 KiB');
    if (buffer.byteLength === length + 4) return buffer.subarray(4);
    if (buffer.byteLength > length + 4) throw new Error('Unexpected database request bytes');
  }
}

if (import.meta.main) await runDatabaseReadProcess();
