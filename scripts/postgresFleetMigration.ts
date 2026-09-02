import { resolve } from 'node:path';
import { assert, freePort, waitForServer } from './flowRuntimeSupport';
import type { NodeRuntime } from './postgresFleetNode';

type Child = ReturnType<typeof Bun.spawn>;

export interface LegacyPostgresSeed {
  queue: string;
  jobId: string;
}

export async function seedLegacyPostgres19(
  postgresUrl: string,
  namespace: string
): Promise<LegacyPostgresSeed> {
  const [httpPort, tcpPort] = await Promise.all([freePort(), freePort()]);
  const queue = `legacy-pg-${Date.now()}`;
  const jobId = `legacy-pg-job-${Date.now()}`;
  const environment: Record<string, string | undefined> = {
    ...process.env,
    AUTH_TOKENS: '',
    BUNQUEUE_BROKER_ID: `legacy-migration-${process.pid}`,
    BUNQUEUE_POSTGRES_NAMESPACE: namespace,
    BUNQUEUE_POSTGRES_URL: postgresUrl,
    BUNQUEUE_STORAGE_DRIVER: 'postgres',
    HTTP_PORT: String(httpPort),
    TCP_PORT: String(tcpPort),
  };
  for (const key of ['BUNQUEUE_DATA_PATH', 'BQ_DATA_PATH', 'DATA_PATH', 'SQLITE_PATH']) {
    delete environment[key];
  }
  const cli = resolve('node_modules/bunqueue-v2-9-2/dist/cli/index.js');
  const child = Bun.spawn(['bun', cli, 'start'], {
    env: environment,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  try {
    await waitForServer(httpPort, child);
    const response = await fetch(`http://127.0.0.1:${httpPort}/queues/${queue}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'legacy-postgres', data: { migrated: true }, jobId }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await response.json()) as { ok?: unknown; id?: unknown; error?: unknown };
    assert(response.ok && body.ok === true && body.id === jobId, `Legacy enqueue failed: ${body.error}`);
    return { queue, jobId };
  } finally {
    await terminate(child);
  }
}

export async function assertPostgresSchemaVersion(
  container: string,
  database: string,
  expected: number
): Promise<void> {
  const child = Bun.spawn(
    [
      'docker',
      'exec',
      container,
      'psql',
      '-U',
      'postgres',
      '-d',
      database,
      '-Atc',
      'SELECT MAX(version) FROM bunqueue_schema_migrations',
    ],
    { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`PostgreSQL schema query failed: ${stderr.trim()}`);
  const version = Number(stdout.trim());
  assert(version === expected, `Expected PostgreSQL schema ${expected}, received ${version}`);
}

export async function assertLegacySeedReadable(
  node: NodeRuntime,
  seed: LegacyPostgresSeed
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${node.httpPort}/jobs/${seed.jobId}`, {
        headers: { Authorization: `Bearer ${node.serverToken}` },
        signal: AbortSignal.timeout(2_000),
      });
      const body = (await response.json()) as { job?: { id?: unknown; queue?: unknown } };
      if (response.ok && body.job?.id === seed.jobId && body.job.queue === seed.queue) return;
    } catch {}
    await Bun.sleep(50);
  }
  throw new Error(`${node.name} did not read the job created before PostgreSQL migration`);
}

async function terminate(child: Child): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([child.exited, Bun.sleep(5_000)]);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await Promise.race([child.exited, Bun.sleep(2_000)]);
  }
}
