import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assert, freePort } from './flowRuntimeSupport';
import {
  assertPostgresSchema20,
  validatePostgresFleetGroups,
} from './postgresFleetGroupScenario';
import {
  assertLegacySeedReadable,
  assertPostgresSchemaVersion,
  seedLegacyPostgres19,
} from './postgresFleetMigration';
import { type NodeRuntime, spawnPostgresFleetNode } from './postgresFleetNode';

type Child = ReturnType<typeof Bun.spawn>;
const message = (value: unknown) => (value instanceof Error ? value.message : String(value));
const tail = (value: string) => value.trim().split('\n').slice(-30).join('\n');

const root = await mkdtemp(join(tmpdir(), 'bunqueue-dashboard-postgres-fleet-'));
const container = `bunqueue-dashboard-postgres-fleet-${process.pid}`;
const postgresPort = await freePort();
const postgresPassword = `fleet-${process.pid}-password`;
const database = 'bunqueue_dashboard';
const namespace = `dashboard_fleet_${process.pid}`;
const postgresUrl = `postgresql://postgres:${postgresPassword}@127.0.0.1:${postgresPort}/${database}`;
const repository = resolve(import.meta.dir, '..');
const cli = join(repository, 'node_modules/bunqueue/dist/cli/index.js');
const nodes: NodeRuntime[] = [];
let containerStarted = false;
let failure: unknown;

try {
  await docker([
    'run',
    '--name',
    container,
    '--rm',
    '-e',
    `POSTGRES_PASSWORD=${postgresPassword}`,
    '-e',
    `POSTGRES_DB=${database}`,
    '-p',
    `127.0.0.1:${postgresPort}:5432`,
    '-d',
    'postgres:18.6-alpine',
  ]);
  containerStarted = true;
  await waitForPostgres();
  const legacy = await seedLegacyPostgres19(postgresUrl, namespace);
  await assertPostgresSchemaVersion(container, database, 19);

  for (let index = 0; index < 3; index++) {
    nodes.push(
      await spawnPostgresFleetNode(index, { repository, root, cli, namespace, postgresUrl })
    );
  }
  await Promise.all(nodes.map(waitForAgent));
  for (const node of nodes) {
    await agentRequest(node, '/control/start', { method: 'POST' });
    await waitForBroker(node);
  }
  await assertPostgresSchema20(container, database);
  await assertLegacySeedReadable(nodes[2], legacy);

  await validateAgentTopology();
  const queue = `dashboard-fleet-${Date.now()}`;
  const created = await serverRequest(nodes[0], `/queues/${queue}/jobs`, {
    method: 'POST',
    body: JSON.stringify({ name: 'cross-broker', data: { source: 'dashboard-postgres-e2e' } }),
  });
  assert(typeof created.id === 'string' && created.id.length > 0, 'created job id is missing');
  const jobId = created.id;

  await waitForJson(nodes[1], `/jobs/${encodeURIComponent(jobId)}`, (body) =>
    (body.job as { id?: unknown } | undefined)?.id === jobId
  );

  const pulled = await serverRequest(nodes[1], `/queues/${queue}/jobs/pull-batch`, {
    method: 'POST',
    body: JSON.stringify({ count: 1, owner: 'dashboard-postgres-fleet-e2e' }),
  });
  const pulledJobs = pulled.jobs as Array<{ id?: string }> | undefined;
  const lockTokens = pulled.tokens as string[] | undefined;
  assert(pulledJobs?.[0]?.id === jobId, 'Broker B did not claim broker A job');
  assert(typeof lockTokens?.[0] === 'string', 'Broker B did not return a portable lock token');
  await serverRequest(nodes[2], '/jobs/ack-batch', {
    method: 'POST',
    body: JSON.stringify({ ids: [jobId], tokens: [lockTokens[0]] }),
  });
  await waitForJson(nodes[0], `/jobs/${encodeURIComponent(jobId)}`, (body) =>
    (body.job as { state?: unknown } | undefined)?.state === 'completed'
  );

  await serverRequest(nodes[2], `/queues/${queue}/pause`, { method: 'POST' });
  await waitForJson(nodes[0], `/dashboard/queues/${queue}?includeJobs=false`, (body) =>
    (body.queue as { paused?: unknown } | undefined)?.paused === true || body.paused === true
  );
  await serverRequest(nodes[1], `/queues/${queue}/resume`, { method: 'POST' });

  const cronName = `fleet-cron-${Date.now()}`;
  await serverRequest(nodes[0], '/crons', {
    method: 'POST',
    body: JSON.stringify({ name: cronName, queue, schedule: '0 0 1 1 *', data: { fleet: true } }),
  });
  await waitForJson(nodes[1], '/crons', (body) =>
    (body.crons as Array<{ name?: string }> | undefined)?.some((cron) => cron.name === cronName) ===
    true
  );
  await serverRequest(nodes[2], `/crons/${encodeURIComponent(cronName)}`, { method: 'DELETE' });

  await serverRequest(nodes[0], `/queues/${queue}/rate-limit`, {
    method: 'PUT',
    body: JSON.stringify({ limit: 7, duration: 60_000 }),
  });
  await waitForAgentJson(
    nodes[2],
    `/queue-operations/${queue}/limits?target=${encodeURIComponent(`http://127.0.0.1:${nodes[2].httpPort}`)}`,
    (body) =>
      (body.limits as { rateLimit?: { max?: number } } | undefined)?.rateLimit?.max === 7
  );
  await serverRequest(nodes[1], `/queues/${queue}/rate-limit`, { method: 'DELETE' });

  await validatePostgresFleetGroups(nodes, queue);

  console.log(
    JSON.stringify(
      {
        bun: Bun.version,
        bunqueue: '2.9.3',
        postgres: '18.6',
        postgresSchema: 20,
        target: `127.0.0.1:${postgresPort}/${database}`,
        namespace,
        brokers: nodes.map(({ name, httpPort, tcpPort, agentPort }) => ({
          name,
          httpPort,
          tcpPort,
          agentPort,
        })),
        verified: [
          'published 2.9.2 schema 19 → 2.9.3 schema 20; legacy job readable on C',
          'three paired control agents',
          'shared PostgreSQL topology discovery',
          'enqueue A → inspect/pull B → acknowledge C → inspect A',
          'pause C → observe A → resume B',
          'create cron A → observe B → delete C',
          'set rate A → inspect with agent C → clear B',
          'group max-size A/B → inspect priorities C',
          'pause group A → observe C → resume B → observe A',
        ],
        status: 'ok',
      },
      null,
      2
    )
  );
} catch (error) {
  failure = error;
} finally {
  for (const node of nodes) {
    await agentRequest(node, '/control/stop', { method: 'POST' }).catch(() => undefined);
  }
  await Promise.all(nodes.map((node) => terminate(node.child)));
  if (containerStarted) await docker(['rm', '-f', container]).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}

if (failure) {
  const logs = await Promise.all(
    nodes.map(async (node) => `${node.name} stdout:\n${tail(await node.stdout)}\n${node.name} stderr:\n${tail(await node.stderr)}`)
  );
  throw new Error(`PostgreSQL fleet validation failed: ${message(failure)}\n${logs.join('\n')}`);
}

async function validateAgentTopology(): Promise<void> {
  const statuses = await Promise.all(nodes.map((node) => agentRequest(node, '/control/status')));
  for (const status of statuses) {
    assert(status.storageMode === 'postgres', 'Agent did not report PostgreSQL storage');
    assert(status.postgresNamespace === namespace, 'Agent reported a different namespace');
    assert(
      status.postgresTarget === `127.0.0.1:${postgresPort}/${database}`,
      'Agent did not expose the credential-free PostgreSQL target'
    );
  }
}

async function waitForPostgres(): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const result = await docker(['exec', container, 'pg_isready', '-U', 'postgres', '-d', database], false);
    if (result === '0') return;
    await Bun.sleep(250);
  }
  throw new Error('Timed out waiting for PostgreSQL');
}

async function waitForAgent(node: NodeRuntime): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (node.child.exitCode !== null) throw new Error(`${node.name} agent exited early`);
    try {
      await agentRequest(node, '/control/status');
      return;
    } catch {}
    await Bun.sleep(50);
  }
  throw new Error(`Timed out waiting for ${node.name} agent`);
}

async function waitForBroker(node: NodeRuntime): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const health = await serverRequest(node, '/health');
      if (health.ok === true) return;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error(`Timed out waiting for ${node.name}`);
}

async function waitForJson(
  node: NodeRuntime,
  path: string,
  predicate: (body: Record<string, unknown>) => boolean
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 15_000;
  let last: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    try {
      last = await serverRequest(node, path);
      if (predicate(last)) return last;
    } catch {}
    await Bun.sleep(50);
  }
  throw new Error(`Timed out waiting for ${node.name}${path}: ${JSON.stringify(last)}`);
}

async function waitForAgentJson(
  node: NodeRuntime,
  path: string,
  predicate: (body: Record<string, unknown>) => boolean
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 15_000;
  let last: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    try {
      last = await agentRequest(node, path);
      if (predicate(last)) return last;
    } catch {}
    await Bun.sleep(50);
  }
  throw new Error(`Timed out waiting for ${node.name} agent${path}: ${JSON.stringify(last)}`);
}

async function serverRequest(
  node: NodeRuntime,
  path: string,
  init: RequestInit = {}
): Promise<Record<string, unknown>> {
  return jsonRequest(`http://127.0.0.1:${node.httpPort}${path}`, node.serverToken, init);
}

async function agentRequest(
  node: NodeRuntime,
  path: string,
  init: RequestInit = {}
): Promise<Record<string, unknown>> {
  return jsonRequest(`http://127.0.0.1:${node.agentPort}${path}`, node.agentToken, init);
}

async function jsonRequest(url: string, token: string, init: RequestInit) {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (init.body) headers.set('Content-Type', 'application/json');
  const response = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(10_000) });
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok || body.ok === false) throw new Error(`${url}: ${body.error ?? `HTTP ${response.status}`}`);
  return body;
}

async function docker(args: string[], strict = true): Promise<string> {
  const child = Bun.spawn(['docker', ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (strict && exitCode !== 0) throw new Error(`docker ${args[0]} failed: ${stderr.trim()}`);
  return strict ? stdout.trim() : String(exitCode);
}

async function terminate(child: Child): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([child.exited, Bun.sleep(5_000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}
