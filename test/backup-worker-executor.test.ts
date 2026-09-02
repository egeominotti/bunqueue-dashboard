import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { executeBackupWorker } from '../agent/backup/workerExecutor';

type WorkerMessage = { operation: string; key?: string };

class FakeWorker {
  static instances: FakeWorker[] = [];

  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  posted: WorkerMessage[] = [];
  terminated = 0;

  constructor(
    readonly url: string,
    readonly options: WorkerOptions
  ) {
    FakeWorker.instances.push(this);
  }

  postMessage(message: WorkerMessage): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated++;
  }

  reply(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }

  fail(message = ''): { prevented: boolean } {
    const state = { prevented: false };
    this.onerror?.({
      message,
      preventDefault: () => {
        state.prevented = true;
      },
    } as ErrorEvent);
    return state;
  }
}

const workerDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Worker');

beforeEach(() => {
  FakeWorker.instances = [];
  Object.defineProperty(globalThis, 'Worker', {
    configurable: true,
    writable: true,
    value: FakeWorker,
  });
});

afterEach(() => {
  if (workerDescriptor) Object.defineProperty(globalThis, 'Worker', workerDescriptor);
  else Reflect.deleteProperty(globalThis, 'Worker');
});

function latest(): FakeWorker {
  const worker = FakeWorker.instances.at(-1);
  if (!worker) throw new Error('Worker was not created');
  return worker;
}

describe('embedded backup worker executor', () => {
  test('posts the exact operation and resolves one successful reply', async () => {
    const controller = new AbortController();
    const pending = executeBackupWorker(
      'file:///backup-worker.ts',
      { S3_BUCKET: 'backups' },
      'restore',
      'daily.db',
      controller.signal
    );
    const worker = latest();
    expect(worker.url).toBe('file:///backup-worker.ts');
    expect(worker.options).toEqual({ type: 'module', env: { S3_BUCKET: 'backups' } });
    expect(worker.posted).toEqual([{ operation: 'restore', key: 'daily.db' }]);

    worker.reply({ ok: true, result: { restored: true } });
    expect(await pending).toEqual({ restored: true });
    expect(worker.terminated).toBe(1);
    worker.reply({ ok: false, error: 'late duplicate' });
    expect(worker.terminated).toBe(1);
  });

  test('rejects a structured worker failure and terminates exactly once', async () => {
    const pending = executeBackupWorker(
      'worker.ts',
      {},
      'status',
      undefined,
      new AbortController().signal
    );
    const worker = latest();
    worker.reply({ ok: false, error: 'invalid credentials' });
    await expect(pending).rejects.toThrow('invalid credentials');
    expect(worker.terminated).toBe(1);
  });

  test('prevents the native worker error and preserves its message', async () => {
    const pending = executeBackupWorker(
      'worker.ts',
      {},
      'list',
      undefined,
      new AbortController().signal
    );
    const worker = latest();
    const event = worker.fail('module failed to load');
    expect(event.prevented).toBe(true);
    await expect(pending).rejects.toThrow('module failed to load');
    expect(worker.terminated).toBe(1);
  });

  test('uses a stable fallback for an empty worker error', async () => {
    const pending = executeBackupWorker(
      'worker.ts',
      {},
      'now',
      undefined,
      new AbortController().signal
    );
    latest().fail();
    await expect(pending).rejects.toThrow('Embedded backup worker failed');
  });

  test('aborts an active worker with the caller reason and ignores later replies', async () => {
    const controller = new AbortController();
    const pending = executeBackupWorker('worker.ts', {}, 'now', undefined, controller.signal);
    const worker = latest();
    const reason = new Error('operator cancelled');
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(worker.terminated).toBe(1);
    worker.reply({ ok: true, result: 'too late' });
    expect(worker.terminated).toBe(1);
  });

  test('rejects before allocating a worker when the signal is already aborted', () => {
    const controller = new AbortController();
    controller.abort('cancelled');
    expect(() =>
      executeBackupWorker('worker.ts', {}, 'status', undefined, controller.signal)
    ).toThrow();
    expect(FakeWorker.instances).toHaveLength(0);
  });

  test('normalizes a non-Error abort reason', async () => {
    const controller = new AbortController();
    const pending = executeBackupWorker('worker.ts', {}, 'list', undefined, controller.signal);
    controller.abort('stop');
    await expect(pending).rejects.toThrow('Backup operation cancelled');
  });
});
