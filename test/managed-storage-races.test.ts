import { describe, expect, test } from 'bun:test';
import type { BackupRunnerPort } from '../agent/backup/runner';
import { ProcessManager } from '../agent/manager';
import type { QueueOperationsPort } from '../agent/queue/types';
import { createFetchHandler } from '../agent/server';
import type { WorkflowRuntimePort } from '../agent/workflow/runtime';

const POSTGRES_ENV = {
  BUNQUEUE_STORAGE_DRIVER: 'postgres',
  BUNQUEUE_POSTGRES_URL: 'postgres://example.invalid/bunqueue',
};

describe('managed storage admission races', () => {
  test('a DB query prepared in SQLite fails closed after config changes to PostgreSQL', async () => {
    const manager = sqliteManager();
    const handle = handler(manager);
    const body = delayedJsonBody('{"sql":"SELECT 1"}');
    const querying = handle(
      new Request('http://agent/db/query', { method: 'POST', body: body.stream })
    );

    await body.reading;
    expect(await switchToPostgres(handle)).toBe(200);
    body.release();

    const response = await querying;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining('Database inspection requires Bunqueue SQLite storage'),
    });
    await handle.close();
  });

  test('a backup body prepared in SQLite cannot configure PostgreSQL mode', async () => {
    const manager = sqliteManager();
    let executions = 0;
    const handle = handler(manager, {
      execute: async () => {
        executions++;
        return { success: true, message: 'unexpected' };
      },
      close: async () => undefined,
    });
    const body = delayedJsonBody(JSON.stringify({ environment: { S3_BACKUP_ENABLED: 'true' } }));
    const configuring = handle(
      new Request('http://agent/backup/configure?target=%2Fapi', {
        method: 'POST',
        body: body.stream,
      })
    );

    await body.reading;
    expect(await switchToPostgres(handle)).toBe(200);
    body.release();

    const response = await configuring;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining('S3 backup requires Bunqueue SQLite storage'),
    });
    expect(executions).toBe(0);
    expect(manager.getConfig().extraEnv).toEqual(POSTGRES_ENV);
    await handle.close();
  });
});

function sqliteManager(): ProcessManager {
  const manager = new ProcessManager();
  manager.setConfig({ dataPath: ':memory:', extraEnv: {} });
  return manager;
}

function handler(manager: ProcessManager, backupRunner: BackupRunnerPort = idleBackupRunner()) {
  return createFetchHandler(
    manager,
    { allowedOrigins: [] },
    { close: async () => undefined } as unknown as WorkflowRuntimePort,
    backupRunner,
    { close: async () => undefined } as QueueOperationsPort
  );
}

async function switchToPostgres(handle: ReturnType<typeof createFetchHandler>): Promise<number> {
  const response = await handle(
    new Request('http://agent/control/config', {
      method: 'PUT',
      body: JSON.stringify({ extraEnv: POSTGRES_ENV }),
    })
  );
  return response.status;
}

function idleBackupRunner(): BackupRunnerPort {
  return {
    execute: async () => ({ success: true, message: 'unused' }),
    close: async () => undefined,
  };
}

function delayedJsonBody(json: string) {
  let announce!: () => void;
  let release!: () => void;
  const reading = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      announce();
      await ready;
      controller.enqueue(new TextEncoder().encode(json));
      controller.close();
    },
  });
  return { reading, release, stream };
}
