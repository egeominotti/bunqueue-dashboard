import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deserialize, serialize } from 'node:v8';

const directory = mkdtempSync(join(tmpdir(), 'bq-db-ipc-'));
const path = join(directory, 'store.db');
const command = [
  process.execPath,
  fileURLToPath(new URL('../agent/db/readProcessMain.ts', import.meta.url)),
];
beforeAll(() => {
  const db = new Database(path);
  db.run('CREATE TABLE jobs(id INTEGER)');
  db.close();
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

async function invoke(message: unknown, disconnect = false) {
  let readyCount = 0;
  let timedOut = false;
  let sendError: unknown;
  const child = Bun.spawn(command, {
    // Keep stdin open and empty: the IPC supervisor must never wait on it.
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    ipc: (event, subprocess) => {
      if (event !== 'ready') return;
      readyCount++;
      try {
        if (disconnect) subprocess.disconnect();
        else subprocess.send(message);
      } catch (error) {
        sendError = error;
        subprocess.kill('SIGKILL');
      }
    },
  });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, 3000);
  try {
    const [code, output, errors] = await Promise.all([
      child.exited,
      new Response(child.stdout).arrayBuffer(),
      new Response(child.stderr).text(),
    ]);
    expect(timedOut).toBe(false);
    expect(sendError).toBeUndefined();
    expect(readyCount).toBe(1);
    expect(errors).toBe('');
    return { code, output: Buffer.from(output) };
  } finally {
    clearTimeout(timer);
    try {
      await child.stdin.end();
    } catch {
      /* child already closed stdin */
    }
    child.disconnect();
  }
}

test('IPC executes SQLite while stdin remains open without data', async () => {
  const result = await invoke(
    serialize({ operation: 'dbQuery', args: [path, 'SELECT 42 AS answer'] })
  );
  expect(result.code).toBe(0);
  expect(deserialize(result.output)).toMatchObject({ ok: true, result: { rows: [[42]] } });
});

test('disconnect before a request exits without leaving a waiting supervisor', async () => {
  const result = await invoke(undefined, true);
  expect(result.code).toBe(1);
  expect(result.output.byteLength).toBe(0);
});

test('IPC rejects malformed and oversized requests without starting a database read', async () => {
  for (const message of [
    { operation: 'dbQuery' },
    Buffer.alloc(128 * 1024 + 1),
    Buffer.from('invalid'),
  ]) {
    const result = await invoke(message);
    expect(result.code).toBe(0);
    expect(deserialize(result.output)).toMatchObject({ ok: false, error: expect.any(String) });
  }
});
