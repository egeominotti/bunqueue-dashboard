import { deserialize, serialize } from 'node:v8';
import { compiledWorkerUrl } from '../compiledRuntime';

/** One request, one readonly connection, one process. Also bundled into the standalone server. */
export async function runDatabaseReadProcess(): Promise<void> {
  let response: unknown;
  let worker: Worker | undefined;
  try {
    if (!process.send || !process.connected) throw new Error('Database process requires an IPC parent');
    // IPC stays separate from stdin, whose pending Windows pipe reads can
    // block worker initialization. Disconnect also covers abrupt parent death.
    process.once('disconnect', () => process.exit(1));
    const pending = new Promise<unknown>((resolve) => process.once('message', resolve));
    process.send('ready');
    const message = await pending;
    if (!(message instanceof Uint8Array) || message.byteLength > 128 * 1024) {
      throw new Error('Invalid database request or request exceeds 128 KiB');
    }
    const input = deserialize(message);
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
  // Exit the whole process, including its SQLite thread and IPC channel.
  worker?.terminate();
  process.exit(0);
}

if (import.meta.main) await runDatabaseReadProcess();
