import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { freePort } from './flowRuntimeSupport';
import { assertPostgresSchema20 } from './postgresFleetGroupScenario';
import { type NodeRuntime, spawnPostgresFleetNode } from './postgresFleetNode';
import { runPostgresFleetDashboardBrowserScenario } from './postgresFleetDashboardBrowserScenario';

type Child = ReturnType<typeof Bun.spawn>;
type DashboardServer = ReturnType<typeof Bun.serve>;

const repository = resolve(import.meta.dir, '..');
const dashboardDist = join(repository, 'dist');
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
let dashboard: DashboardServer | null = null;
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
  await assertPostgresSchema20(container, database);

  dashboard = await serveDashboard();
  await waitForDashboard();

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
        bunqueue: '2.9.3',
        postgres: '18.6',
        postgresSchema: 20,
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
  dashboard?.stop(true);
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
  throw new Error(
    `PostgreSQL fleet Dashboard browser validation failed: ${message(failure)}\n${nodeLogs.join('\n')}`
  );
}

async function serveDashboard(): Promise<DashboardServer> {
  const indexPath = join(dashboardDist, 'index.html');
  if (!(await Bun.file(indexPath).exists())) {
    throw new Error('Production Dashboard fixture is missing; run `bun run build` first');
  }
  return Bun.serve({
    hostname: '127.0.0.1',
    port: dashboardPort,
    async fetch(request) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
      }
      let pathname: string;
      try {
        pathname = decodeURIComponent(new URL(request.url).pathname);
      } catch {
        return new Response('Bad request', { status: 400 });
      }
      const relative = pathname.replace(/^\/+/, '');
      const assetPath = resolve(dashboardDist, relative);
      if (assetPath !== dashboardDist && !assetPath.startsWith(`${dashboardDist}${sep}`)) {
        return new Response('Bad request', { status: 400 });
      }
      const asset = Bun.file(assetPath);
      const body = relative && (await asset.exists()) ? asset : Bun.file(indexPath);
      return new Response(request.method === 'HEAD' ? null : body, {
        headers: { 'Content-Type': body.type || 'application/octet-stream' },
      });
    },
  });
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

async function waitForDashboard(): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(dashboardUrl, { signal: AbortSignal.timeout(1_000) });
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
