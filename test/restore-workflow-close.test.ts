import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import type { BackupRunnerPort } from '../agent/backup/runner';
import { ProcessManager } from '../agent/manager';
import { createFetchHandler } from '../agent/server';
import type { WorkflowRuntimePort } from '../agent/workflow/runtime';

const paths: string[] = [];

afterEach(() => {
  for (const path of paths.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  }
});

function walDatabase(): { path: string; connection: Database } {
  const path = `/tmp/bunqueue-dashboard-restore-close-${crypto.randomUUID()}.db`;
  paths.push(path);
  const connection = new Database(path, { create: true });
  connection.run('PRAGMA journal_mode = WAL');
  connection.run('PRAGMA wal_autocheckpoint = 0');
  connection.run('CREATE TABLE workflow_state (value TEXT NOT NULL)');
  connection.query('INSERT INTO workflow_state VALUES (?)').run('pending in WAL');
  return { path, connection };
}

/** Stands in for the Workflow Engine: the only read-write connection left open. */
function runtimeHolding(connection: Database): WorkflowRuntimePort & { closed: () => boolean } {
  let closed = false;
  const unused = () => Promise.reject(new Error('not used by restore'));
  return {
    status: unused,
    initialize: unused,
    reload: unused,
    start: unused,
    signal: unused,
    recover: unused,
    resumeCompensation: unused,
    abandonCompensation: unused,
    archive: unused,
    cleanup: unused,
    close: async () => {
      // Closing the last connection checkpoints the WAL into the main file and
      // removes -wal/-shm: the files change although nobody else wrote to them.
      if (!closed) connection.close();
      closed = true;
    },
    closed: () => closed,
  };
}

function restoreRequest(database: unknown, target: string): Request {
  return new Request(`http://agent/backup/restore?target=${encodeURIComponent(target)}`, {
    method: 'POST',
    body: JSON.stringify({ key: 'backup.db', database }),
  });
}

describe('backup restore authorization vs. Workflow Engine release', () => {
  test('authorizes against the confirmed database before releasing the engine connection', async () => {
    const { path, connection } = walDatabase();
    const manager = new ProcessManager();
    manager.setConfig({ dataPath: path });
    const confirmed = await manager.dbStats();
    expect(confirmed.walSize).toBeGreaterThan(0);

    const runtime = runtimeHolding(connection);
    let runnerCalls = 0;
    const runner: BackupRunnerPort = {
      execute: async () => {
        runnerCalls += 1;
        return { success: true, message: 'restored' };
      },
      close: async () => undefined,
    };
    const handle = createFetchHandler(manager, { allowedOrigins: [] }, runtime, runner);
    const target = `http://127.0.0.1:${manager.getConfig().httpPort}`;

    const response = await handle(restoreRequest(confirmed, target));
    expect(await response.json()).toMatchObject({ ok: true });
    expect(response.status).toBe(200);
    expect(runtime.closed()).toBe(true);
    expect(runnerCalls).toBe(1);
    // The release really did change the files; the confirmation still holds.
    expect(await manager.dbStats()).not.toEqual(confirmed);
    await handle.close();
  });

  test('still rejects a database that changed after confirmation and names what changed', async () => {
    const { path, connection } = walDatabase();
    const manager = new ProcessManager();
    manager.setConfig({ dataPath: path });
    const confirmed = await manager.dbStats();
    connection.query('INSERT INTO workflow_state VALUES (?)').run('written after confirmation');

    const runtime = runtimeHolding(connection);
    let runnerCalls = 0;
    const runner: BackupRunnerPort = {
      execute: async () => {
        runnerCalls += 1;
        return { success: true, message: 'must not run' };
      },
      close: async () => undefined,
    };
    const handle = createFetchHandler(manager, { allowedOrigins: [] }, runtime, runner);
    const target = `http://127.0.0.1:${manager.getConfig().httpPort}`;

    const response = await handle(restoreRequest(confirmed, target));
    expect(response.status).toBe(400);
    const { error } = (await response.json()) as { error: string };
    expect(error).toContain('Database changed after restore confirmation');
    expect(error).toContain('walSize');
    expect(error).toContain('reload status and confirm again');
    expect(runnerCalls).toBe(0);
    await runtime.close();
    await handle.close();
  });
});

describe('backup restore authorization vs. SQLite shared-memory index', () => {
  test('ignores a -shm index that disappears when another connection closes', async () => {
    const { path, connection } = walDatabase();
    // Fold the WAL into the main file so only the -shm index remains volatile.
    connection.run('PRAGMA wal_checkpoint(TRUNCATE)');
    const manager = new ProcessManager();
    manager.setConfig({ dataPath: path });
    const confirmed = await manager.dbStats();
    expect(confirmed.shmSize).toBeGreaterThan(0);

    // The last connection closing removes -shm (and the empty -wal); the data is untouched.
    // Bun's bundled SQLite (Linux CI) deletes the index on close, while macOS's system
    // SQLite may keep it, so model the Linux behavior explicitly.
    connection.close();
    rmSync(`${path}-shm`, { force: true });
    const current = await manager.dbStats();
    expect(current.shmSize).toBe(0);
    expect(current.size).toBe(confirmed.size);
    expect(current.mtimeMs).toBe(confirmed.mtimeMs);

    let runnerCalls = 0;
    const runner: BackupRunnerPort = {
      execute: async () => {
        runnerCalls += 1;
        return { success: true, message: 'restored' };
      },
      close: async () => undefined,
    };
    const handle = createFetchHandler(
      manager,
      { allowedOrigins: [] },
      runtimeHolding(new Database(':memory:')),
      runner
    );
    const target = `http://127.0.0.1:${manager.getConfig().httpPort}`;

    const response = await handle(restoreRequest(confirmed, target));
    expect(await response.json()).toMatchObject({ ok: true });
    expect(runnerCalls).toBe(1);
    await handle.close();
  });
});
