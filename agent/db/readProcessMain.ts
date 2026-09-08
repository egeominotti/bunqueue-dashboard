import { deserialize, serialize } from 'node:v8';
import { compiledWorkerUrl } from '../compiledRuntime';

/** One request, one readonly connection, one process. Also bundled into the standalone server. */
export async function runDatabaseReadProcess(): Promise<void> {
  let response: unknown;
  let worker: Worker | undefined;
  const trace = (phase: string, details: Record<string, unknown> = {}): void => {
    if (process.env.BQ_DB_PROCESS_TRACE === '1') console.error(JSON.stringify({ component: 'db-supervisor', phase, ...details }));
  };
  try {
    trace('started', { module: import.meta.url, ipc: Boolean(process.send), connected: process.connected });
    if (!process.send || !process.connected) throw new Error('Database process requires an IPC parent');
    // Keep request delivery and parent liveness separate from standard streams.
    // Disconnect also covers abrupt parent death.
    process.once('disconnect', () => process.exit(1));
    const pending = new Promise<unknown>((resolve) => process.once('message', resolve));
    process.send('ready');
    const message = await pending;
    trace('request-received');
    if (!(message instanceof Uint8Array) || message.byteLength > 128 * 1024) {
      throw new Error('Invalid database request or request exceeds 128 KiB');
    }
    let input: unknown = deserialize(message);
    let workerUrl = compiledWorkerUrl(import.meta.url, 'agent/dbReadWorker.js')
      ?? new URL('../dbReadWorker.ts', import.meta.url).href;
    let customWorker = false;
    if (input && typeof input === 'object' && 'customWorkerUrl' in input) {
      if (typeof input.customWorkerUrl !== 'string' || !input.customWorkerUrl || !('request' in input)) {
        throw new Error('Invalid database worker override');
      }
      workerUrl = input.customWorkerUrl;
      input = input.request;
      customWorker = true;
    }
    trace('creating-worker', customWorker ? { customWorker: true } : { workerUrl });
    worker = new Worker(workerUrl, { type: 'module' });
    trace('worker-created');
    response = await new Promise<unknown>((resolve, reject) => {
      worker!.addEventListener('message', (event: MessageEvent) => { trace('worker-result'); resolve(event.data); });
      worker!.addEventListener('error', (event: ErrorEvent) => {
        event.preventDefault?.();
        reject(new Error(event.message || 'Database worker failed'));
      });
      worker!.postMessage(input);
    });
  } catch (error) {
    trace('failed');
    response = {
      ok: false,
      error: error instanceof Error ? error.message : 'Database read failed',
    };
  }
  const output = serialize(response);
  await Bun.write(Bun.stdout, output.byteLength <= 32 * 1024 * 1024
    ? output
    : serialize({ ok: false, error: 'Database result exceeded 32 MiB' }));
  trace('output-written', { bytes: output.byteLength });
  // Exit the whole process, including its SQLite thread and IPC channel.
  worker?.terminate();
  process.exit(0);
}

if (import.meta.main) await runDatabaseReadProcess();
