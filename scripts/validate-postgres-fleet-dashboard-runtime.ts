import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { freePort } from './flowRuntimeSupport';
import { type NodeRuntime, spawnPostgresFleetNode } from './postgresFleetNode';
import { runPostgresFleetDashboardBrowserScenario } from './postgresFleetDashboardBrowserScenario';

type Child = ReturnType<typeof Bun.spawn>;

const repository = resolve(import.meta.dir, '..');
const root = await mkdtemp(join(tmpdir(), 'bunqueue-dashboard-postgres-fleet-browser-'));
const container = `bunqueue-dashboard-postgres-fleet-browser-${process.pid}`;
const [postgresPort, dashboardPort] = await Promise.all([freePort(), freePort()]);
const database = 'bunqueue_dashboard_browser';
const namespace = `dashboard_browser_${process.pid}`;
const password = `dashboard-browser-${process.pid}`;
const postgresUrl = `postgresql://postgres:${password}@127.0.0.1:${postgresPort}/${database}`;
const dashboardUrl = `http://127.0.0.1:${dashboardPort}`;
const cli = join(repository, 'node_modules/bunqueue/dist/cli/index.js');
const nodes: NodeRuntime[] = [];
let dashboard: Child | null = null;
let dashboardStdout: Promise<string> | null = null;
let dashboardStderr: Promise<string> | null = null;
let containerStarted = false;
let failure: unknown;

try {
  await docker([
    'run',
    '--name',
    container,
    '--rm',
    '-e',
    `POSTGRES_PASSWORD=${password}`,
    '-e',
    `POSTGRES_DB=${database}`,
    '-p',
    `127.0.0.1:${postgresPort}:5432`,
    '-d',
    'postgres:18.6-alpine',
  ]);
  containerStarted = true;
  await waitForPostgres();

  for (let index = 0; index < 3; index += 1) {
    nodes.push(
      await spawnPostgresFleetNode(index, {
        repository,
        root,
        cli,
        namespace,
        postgresUrl,
        corsAllowOrigin: dashboardUrl,
      })
    );
  }
  await Promise.all(nodes.map(waitForAgent));
  for (const node of nodes) {
    await agentRequest(node, '/control/start', { method: 'POST' });
    await waitForBroker(node);
  }

  const dashboardChild = Bun.spawn(
    [
      'bun',
      'x',
      '--bun',
      '--no-install',
      'vite',
      '--host',
      '127.0.0.1',
      '--port',
      String(dashboardPort),
      '--strictPort',
    ],
    { cwd: repository, env: { ...process.env }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }
  );
  dashboard = dashboardChild;
  dashboardStdout = new Response(dashboardChild.stdout).text();
  dashboardStderr = new Response(dashboardChild.stderr).text();
  await waitForDashboard(dashboardChild);

  await runPostgresFleetDashboardBrowserScenario({
    dashboardUrl,
    postgresTarget: `127.0.0.1:${postgresPort}/${database}`,
    namespace,
    nodes: nodes.map((node, index) => ({
      name: `Broker ${index + 1}`,
      serverUrl: `http://127.0.0.1:${node.httpPort}`,
      agentUrl: `http://127.0.0.1:${node.agentPort}`,
      serverToken: node.serverToken,
      agentToken: node.agentToken,
    })),
  });

  console.log(
    JSON.stringify(
      {
        bun: Bun.version,
        bunqueue: '2.9.2',
        postgres: '18.6',
        brokers: nodes.length,
        verified: 'real Dashboard UI over a shared PostgreSQL fleet',
        status: 'ok',
      },
      null,
      2
    )
  );
} catch (error) {
  failure = error;
} finally {
  await terminate(dashboard);
  for (const node of nodes) {
    await agentRequest(node, '/control/stop', { method: 'POST' }).catch(() => undefined);
  }
  await Promise.all(nodes.map((node) => terminate(node.child)));
  if (containerStarted) await docker(['rm', '-f', container]).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}

if (failure) {
  const nodeLogs = await Promise.all(
    nodes.map(
      async (node) =>
        `${node.name} stdout:\n${tail(await node.stdout)}\n${node.name} stderr:\n${tail(await node.stderr)}`
    )
  );
  const dashboardLogs = [
    `dashboard stdout:\n${tail((await dashboardStdout) ?? '')}`,
    `dashboard stderr:\n${tail((await dashboardStderr) ?? '')}`,
  ];
  throw new Error(
    `PostgreSQL fleet Dashboard browser validation failed: ${message(failure)}\n${[
      ...dashboardLogs,
      ...nodeLogs,
    ].join('\n')}`
  );
}

async function waitForPostgres(): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const code = await docker(
      ['exec', container, 'pg_isready', '-U', 'postgres', '-d', database],
      false
    );
    if (code === '0') return;
    await Bun.sleep(250);
  }
  throw new Error('Timed out waiting for PostgreSQL');
}

async function waitForAgent(node: NodeRuntime): Promise<void> {
  const deadline = Date.now() + 20_000;
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
      const health = await jsonRequest(
        `http://127.0.0.1:${node.httpPort}/health`,
        node.serverToken
      );
      if (health.ok === true) return;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error(`Timed out waiting for ${node.name}`);
}

async function waitForDashboard(child: Child): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Dashboard exited with ${child.exitCode}`);
    try {
      const response = await fetch(dashboardUrl);
      if (response.ok) return;
    } catch {}
    await Bun.sleep(50);
  }
  throw new Error('Timed out waiting for Dashboard');
}

async function agentRequest(
  node: NodeRuntime,
  path: string,
  init: RequestInit = {}
): Promise<Record<string, unknown>> {
  return jsonRequest(`http://127.0.0.1:${node.agentPort}${path}`, node.agentToken, init);
}

async function jsonRequest(
  url: string,
  token: string,
  init: RequestInit = {}
): Promise<Record<string, unknown>> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (init.body) headers.set('Content-Type', 'application/json');
  const response = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(10_000) });
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok || body.ok === false) {
    throw new Error(`${url}: ${body.error ?? `HTTP ${response.status}`}`);
  }
  return body;
}

async function docker(args: string[], strict = true): Promise<string> {
  const child = Bun.spawn(['docker', ...args], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (strict && exitCode !== 0) throw new Error(`docker ${args[0]}: ${stderr.trim()}`);
  return strict ? stdout.trim() : String(exitCode);
}

async function terminate(child: Child | null): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([child.exited, Bun.sleep(5_000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

function message(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function tail(value: string): string {
  return value.trim().split('\n').slice(-30).join('\n');
}
