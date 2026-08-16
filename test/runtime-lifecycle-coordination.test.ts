import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import type { BackupRunnerPort } from '../agent/backup/runner';
import { ProcessManager } from '../agent/manager';
import { createFetchHandler } from '../agent/server';

const paths: string[] = [];

afterEach(() => {
  for (const path of paths.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  }
});

describe('agent DB lifecycle coordination', () => {
  test('pins restore only after its body is complete and rejects a changed DB target', async () => {
    const manager = new ProcessManager();
    const originalPath = markerDatabase('slow-restore-original', 'original');
    const nextPath = markerDatabase('slow-restore-next', 'next');
    manager.setConfig({ dataPath: originalPath });
    const database = await manager.dbStats();
    let runnerCalls = 0;
    const runner: BackupRunnerPort = {
      execute: async () => {
        runnerCalls += 1;
        return { success: true, message: 'must not run' };
      },
      close: async () => undefined,
    };
    const handle = createFetchHandler(manager, { allowedOrigins: [] }, undefined, runner);
    const delayed = delayedBody(JSON.stringify({ key: 'backup.db', database }));
    const target = `http://127.0.0.1:${manager.getConfig().httpPort}`;
    const restoring = handle(
      new Request(`http://agent/backup/restore?target=${encodeURIComponent(target)}`, {
        method: 'POST',
        body: delayed.stream,
      })
    );
    await delayed.reading;

    const updated = await handle(
      new Request('http://agent/control/config', {
        method: 'PUT',
        body: JSON.stringify({
          dataPath: nextPath,
          expectedRevision: manager.getConfigRevision(),
        }),
      })
    );
    expect(updated.status).toBe(200);
    delayed.release();

    const rejected = await restoring;
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({
      error: expect.stringContaining('Database changed after restore confirmation'),
    });
    expect(runnerCalls).toBe(0);
    await handle.close();
  });

  test('serializes status, DB readers and config writers behind a restore', async () => {
    const manager = new ProcessManager();
    const dataPath = markerDatabase('restore-source', 'before-restore');
    const nextPath = markerDatabase('restore-next', 'after-restore');
    manager.setConfig({ command: 'sleep 30', dataPath });
    const database = await manager.dbStats();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const runner: BackupRunnerPort = {
      execute: async () => {
        entered();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { success: true, message: 'restored' };
      },
      close: async () => undefined,
    };
    const handle = createFetchHandler(manager, { allowedOrigins: [] }, undefined, runner);
    const target = `http://127.0.0.1:${manager.getConfig().httpPort}`;
    const restoring = handle(
      new Request(`http://agent/backup/restore?target=${encodeURIComponent(target)}`, {
        method: 'POST',
        body: JSON.stringify({ key: 'backup.db', database }),
      })
    );
    await started;

    let querySettled = false;
    let configSettled = false;
    let statusSettled = false;
    const status = handle(new Request('http://agent/control/status')).finally(() => {
      statusSettled = true;
    });
    const query = handle(
      new Request('http://agent/db/query', {
        method: 'POST',
        body: JSON.stringify({ sql: 'SELECT value FROM lifecycle_marker' }),
      })
    ).finally(() => {
      querySettled = true;
    });
    await Bun.sleep(0);
    const configUpdate = handle(
      new Request('http://agent/control/config', {
        method: 'PUT',
        body: JSON.stringify({
          dataPath: nextPath,
          expectedRevision: manager.getConfigRevision(),
        }),
      })
    ).finally(() => {
      configSettled = true;
    });
    await Bun.sleep(0);
    expect(statusSettled).toBe(false);
    expect(querySettled).toBe(false);
    expect(configSettled).toBe(false);

    release();
    expect((await restoring).status).toBe(200);
    expect((await status).status).toBe(200);
    const queryResponse = await query;
    expect(queryResponse.status).toBe(200);
    expect(await queryResponse.json()).toMatchObject({ rows: [['before-restore']] });
    expect((await configUpdate).status).toBe(200);
    expect(manager.getConfig().dataPath).toBe(nextPath);
    await handle.close();
  });

  test('keeps DB inspection and storage stats on runningConfig until restart', async () => {
    const manager = new ProcessManager();
    const runningPath = markerDatabase('live-db', 'running');
    const desiredPath = markerDatabase('future-db', 'desired');
    manager.setConfig({ command: 'sleep 30', dataPath: runningPath });
    await manager.start();
    manager.setConfig({ dataPath: desiredPath });
    const handle = createFetchHandler(manager, { allowedOrigins: [] });
    try {
      const query = await handle(
        new Request('http://agent/db/query', {
          method: 'POST',
          body: JSON.stringify({ sql: 'SELECT value FROM lifecycle_marker' }),
        })
      );
      expect(query.status).toBe(200);
      expect(await query.json()).toMatchObject({ rows: [['running']] });
      const status = (await (await handle(new Request('http://agent/control/status'))).json()) as {
        db: { path: string };
        runningConfig: { dataPath: string };
      };
      expect(status.db.path).toBe(runningPath);
      expect(status.runningConfig.dataPath).toBe(runningPath);
    } finally {
      await manager.stop();
      await handle.close();
    }
  });
});

describe('agent status lifecycle coordination', () => {
  test('discards health from a process that exits while its status probe is pending', async () => {
    const manager = new ProcessManager();
    manager.setConfig({ command: 'sleep 30' });
    await manager.start();
    const handle = createFetchHandler(manager, { allowedOrigins: [] });
    const realFetch = globalThis.fetch;
    let probeEntered!: () => void;
    let resolveProbe!: (response: Response) => void;
    const entered = new Promise<void>((resolve) => {
      probeEntered = resolve;
    });
    const pendingProbe = new Promise<Response>((resolve) => {
      resolveProbe = resolve;
    });
    globalThis.fetch = (() => {
      probeEntered();
      return pendingProbe;
    }) as typeof fetch;
    try {
      const pendingStatus = handle(new Request('http://agent/control/status'));
      await entered;
      await manager.stop();
      resolveProbe(Response.json({ ok: true, version: 'stale-version' }));
      const response = await pendingStatus;
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        status: 'stopped',
        pid: null,
        healthy: false,
      });
    } finally {
      globalThis.fetch = realFetch;
      await manager.stop();
      await handle.close();
    }
  });
});

function markerDatabase(label: string, value: string): string {
  const path = `/tmp/bunqueue-dashboard-${label}-${crypto.randomUUID()}.db`;
  paths.push(path);
  const db = new Database(path, { create: true });
  db.run('CREATE TABLE lifecycle_marker (value TEXT NOT NULL)');
  db.query('INSERT INTO lifecycle_marker VALUES (?)').run(value);
  db.close();
  return path;
}

function delayedBody(value: string) {
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
      controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    },
  });
  return { reading, release, stream };
}
