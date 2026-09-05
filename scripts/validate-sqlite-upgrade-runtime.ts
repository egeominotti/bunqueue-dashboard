import { assertBunqueueRuntimeVersion, installedBunqueueVersion } from './bunqueueRuntimeVersion';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assert, freePort, waitForServer } from './flowRuntimeSupport';

type Child = ReturnType<typeof Bun.spawn>;
const message = (value: unknown) => (value instanceof Error ? value.message : String(value));

const root = await mkdtemp(join(tmpdir(), 'bunqueue-dashboard-sqlite-upgrade-'));
const databasePath = join(root, 'bunqueue.db');
const queue = `upgrade-${Date.now()}`;
const oldCli = resolve('node_modules/bunqueue-v2-9-2/dist/cli/index.js');
const newCli = resolve('node_modules/bunqueue/dist/cli/index.js');
const jobIds = Array.from({ length: 3 }, (_, index) => `legacy-completed-${Date.now()}-${index}`);
let broker: Child | null = null;
let activeHttpPort = 0;

try {
  broker = await startBroker(oldCli, {});
  for (const [index, jobId] of jobIds.entries()) {
    const created = await request(`/queues/${queue}/jobs`, {
      method: 'POST',
      body: JSON.stringify({ name: `legacy-${index}`, data: { index }, jobId, durable: true }),
    });
    assert(created.id === jobId, `2.9.2 did not preserve legacy job ID ${jobId}`);
    const pulled = await request(`/queues/${queue}/jobs/pull-batch`, {
      method: 'POST',
      body: JSON.stringify({ count: 1, owner: 'sqlite-upgrade-fixture' }),
    });
    const ids = pulled.jobs as Array<{ id?: unknown }> | undefined;
    const tokens = pulled.tokens as unknown[] | undefined;
    assert(ids?.[0]?.id === jobId, `2.9.2 did not claim ${jobId}`);
    assert(typeof tokens?.[0] === 'string', `2.9.2 did not issue a lock token for ${jobId}`);
    await request('/jobs/ack-batch', {
      method: 'POST',
      body: JSON.stringify({ ids: [jobId], tokens: [tokens[0]] }),
    });
    await waitForCompleted(jobId);
  }
  await stopBroker(broker);
  broker = null;
  assert(readSchemaVersion() === 35, 'Bunqueue 2.9.2 fixture did not create SQLite schema 35');
  assert(countCompletedRows() === 3, 'Bunqueue 2.9.2 fixture did not persist three completions');

  broker = await startBroker(newCli, { BUNQUEUE_MAX_COMPLETED_JOBS: '1' });
  assert(readSchemaVersion() === 37, 'Bunqueue target did not migrate SQLite to schema 37');
  for (const jobId of jobIds) {
    const body = await request(`/jobs/${jobId}`);
    const job = body.job as { id?: unknown; state?: unknown } | undefined;
    assert(job?.id === jobId && job.state === 'completed', `Target could not read ${jobId}`);
  }
  await stopBroker(broker);
  broker = null;
  assert(
    countCompletedRows() === 3,
    'BUNQUEUE_MAX_COMPLETED_JOBS incorrectly deleted durable completed rows'
  );
  assert(tableExists('completed_job_counts'), 'SQLite schema 37 maintenance table is missing');

  broker = await startBroker(newCli, { BUNQUEUE_MAX_COMPLETED_JOBS: '1' });
  for (const jobId of jobIds) await waitForCompleted(jobId);

  console.log(
    JSON.stringify(
      {
        bun: Bun.version,
        upgraded: `Bunqueue 2.9.2 → ${installedBunqueueVersion}`,
        sqliteSchema: '35 → 37',
        completedRows: 3,
        maxCompletedJobs: 1,
        verified: [
          'completed jobs survive migration',
          'hot recovery cap does not delete durable rows',
          'schema-37 database reopens after restart',
        ],
        status: 'ok',
      },
      null,
      2
    )
  );
} finally {
  if (broker) await stopBroker(broker);
  await rm(root, { recursive: true, force: true });
}

async function startBroker(cli: string, extraEnv: Record<string, string>): Promise<Child> {
  const [httpPort, tcpPort] = await Promise.all([freePort(), freePort()]);
  activeHttpPort = httpPort;
  const child = Bun.spawn(['bun', cli, 'start'], {
    env: {
      ...process.env,
      HTTP_PORT: String(httpPort),
      TCP_PORT: String(tcpPort),
      BUNQUEUE_DATA_PATH: databasePath,
      AUTH_TOKENS: '',
      ...extraEnv,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  try {
    await waitForServer(httpPort, child);
    await assertBunqueueRuntimeVersion(httpPort, undefined, cli === oldCli ? '2.9.2' : installedBunqueueVersion);
    return child;
  } catch (error) {
    const stderr = await new Response(child.stderr).text();
    throw new Error(`Broker failed to start: ${message(error)}\n${stderr}`);
  }
}

async function request(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('Content-Type', 'application/json');
  const response = await fetch(`http://127.0.0.1:${activeHttpPort}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok || body.ok === false) {
    throw new Error(`${path}: ${body.error ?? `HTTP ${response.status}`}`);
  }
  return body;
}

async function waitForCompleted(jobId: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const body = await request(`/jobs/${jobId}`);
      if ((body.job as { state?: unknown } | undefined)?.state === 'completed') return;
    } catch {}
    await Bun.sleep(25);
  }
  throw new Error(`Job ${jobId} did not remain completed`);
}

function readSchemaVersion(): number {
  return readDatabase((db) => {
    const row = db.query('SELECT MAX(version) AS version FROM migrations').get() as {
      version?: unknown;
    } | null;
    return Number(row?.version ?? 0);
  });
}

function countCompletedRows(): number {
  return readDatabase((db) => {
    const row = db.query("SELECT COUNT(*) AS count FROM jobs WHERE state = 'completed'").get() as {
      count?: unknown;
    } | null;
    return Number(row?.count ?? 0);
  });
}

function tableExists(name: string): boolean {
  return readDatabase(
    (db) =>
      db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== null
  );
}

function readDatabase<T>(read: (db: Database) => T): T {
  const db = new Database(databasePath, { readonly: true });
  try {
    return read(db);
  } finally {
    db.close(false);
  }
}

async function stopBroker(child: Child): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([child.exited, Bun.sleep(5_000)]);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await Promise.race([child.exited, Bun.sleep(2_000)]);
  }
}
