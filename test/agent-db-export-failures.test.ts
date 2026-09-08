import { afterEach, describe, expect, test } from 'bun:test';
import { exportWithTimeout, exportWorkerLoad } from '../agent/db/exportTimeout';
import { DbExportUnavailableError } from '../agent/db/types';
import { setExportWorkerFactory } from '../agent/db/workerFactory';

afterEach(() => {
  setExportWorkerFactory(null);
  expect(exportWorkerLoad()).toBe(0);
});

describe('export process faults', () => {
  test('a synchronous request transport failure releases the pool and reports unavailability', async () => {
    let terminated = false;
    setExportWorkerFactory(() => ({
      addEventListener: () => {},
      postMessage: () => {
        throw new Error('closed request pipe');
      },
      terminate: () => {
        terminated = true;
      },
      exited: Promise.resolve(),
    }));
    await expect(exportWithTimeout('store.db', 'jobs')).rejects.toThrow(
      'Could not start database export'
    );
    expect(terminated).toBe(true);
  });

  test('a crashed child is reaped before its export rejection is observed', async () => {
    let release!: () => void;
    const exited = new Promise<void>((resolve) => {
      release = resolve;
    });
    const listeners = new Map<string, (event: unknown) => void>();
    setExportWorkerFactory(() => ({
      addEventListener: (type, listener) => {
        listeners.set(type, listener as (event: unknown) => void);
      },
      postMessage: () => {
        queueMicrotask(() => listeners.get('error')?.({ message: 'child crash' }));
      },
      terminate: () => {},
      exited,
    }));
    let settled = false;
    const pending = exportWithTimeout('store.db', 'jobs').catch((error) => {
      settled = true;
      return error;
    });
    await Bun.sleep(1);
    expect(settled).toBe(false);
    expect(exportWorkerLoad()).toBe(1);
    release();
    expect(await pending).toBeInstanceOf(DbExportUnavailableError);
  });
});
