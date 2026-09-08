import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Queue } from 'bunqueue/client';
import {
  createE2EUpstreamEnvironment,
  E2E_AGENT_PORT,
  E2E_APP_URL,
  E2E_BASE_PATH,
  E2E_CONTROL_PORT,
  E2E_CONTROL_TOKEN,
  E2E_DASHBOARD_PORT,
  E2E_HTTP_PORT,
  E2E_LOOPBACK_HOST,
  E2E_SEED_QUEUE,
  E2E_SERVER_TOKEN,
  E2E_TCP_PORT,
} from './config';
import { acceptsTcpConnection, assertUpstreamIsLoopbackOnly } from './networkPolicy';

type Child = ReturnType<typeof Bun.spawn>;

const repository = resolve(import.meta.dir, '..');
const scratch = await mkdtemp(join(tmpdir(), 'bunqueue-dashboard-browser-e2e-'));
const database = join(scratch, 'bunqueue.db');
const upstreamCommand = resolve(repository, 'node_modules/bunqueue/dist/cli/index.js');

let upstream: Child | null = null;
let dashboard: Child | null = null;
let stopping = false;
let exitCode = 0;
let resolveExit: () => void = () => undefined;
const exitRequested = new Promise<void>((resolveExitRequest) => {
  resolveExit = resolveExitRequest;
});

function spawnUpstream(): Child {
  return Bun.spawn(['bun', upstreamCommand, 'start'], {
    cwd: repository,
    env: createE2EUpstreamEnvironment(database),
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
  });
}

async function waitForHttp(url: string, child: Child, label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${label} exited with ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The child is still binding its loopback listener.
    }
    await Bun.sleep(50);
  }
  throw new Error(`Timed out waiting for ${label} at ${url}`);
}

async function waitForTcp(child: Child): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Bunqueue exited with ${child.exitCode}`);
    if (await acceptsTcpConnection(E2E_LOOPBACK_HOST, E2E_TCP_PORT)) return;
    await Bun.sleep(50);
  }
  throw new Error(`Timed out waiting for Bunqueue TCP at ${E2E_LOOPBACK_HOST}:${E2E_TCP_PORT}`);
}

async function exitsWithin(child: Child, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    child.exited.then(() => true),
    new Promise<boolean>((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout(false), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function terminate(child: Child | null): Promise<void> {
  if (child?.exitCode !== null) return;
  child.kill('SIGTERM');
  if (await exitsWithin(child, 5_000)) return;
  child.kill('SIGKILL');
  if (!(await exitsWithin(child, 2_000))) {
    throw new Error(`Browser E2E child ${child.pid} did not terminate`);
  }
}

async function startUpstream(): Promise<void> {
  if (upstream?.exitCode === null) return;
  const child = spawnUpstream();
  upstream = child;
  try {
    await waitForHttp(`http://${E2E_LOOPBACK_HOST}:${E2E_HTTP_PORT}/ready`, child, 'Bunqueue');
    await waitForTcp(child);
    await assertUpstreamIsLoopbackOnly();
  } catch (error) {
    upstream = null;
    await terminate(child);
    throw error;
  }
}

async function stopUpstream(): Promise<void> {
  const child = upstream;
  upstream = null;
  await terminate(child);
}

async function enqueue(queueName: string): Promise<string> {
  if (upstream?.exitCode !== null) throw new Error('Bunqueue is not running');
  const queue = new Queue(queueName, {
    autoBatch: { enabled: false },
    connection: {
      host: E2E_LOOPBACK_HOST,
      port: E2E_TCP_PORT,
      poolSize: 1,
      token: E2E_SERVER_TOKEN,
    },
  });
  try {
    await queue.waitUntilReady();
    const job = await queue.add('browser-e2e', {
      source: 'playwright',
      createdAt: Date.now(),
    });
    return String(job.id);
  } finally {
    queue.close();
  }
}

function validQueueName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/u.test(value);
}

async function controlRequest(request: Request): Promise<Response> {
  if (request.headers.get('authorization') !== `Bearer ${E2E_CONTROL_TOKEN}`) {
    return Response.json({ ok: false, error: 'Forbidden' }, { status: 403 });
  }
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/health') {
    return Response.json({ ok: true, upstream: upstream?.exitCode === null });
  }
  if (request.method !== 'POST') {
    return Response.json({ ok: false, error: 'Not found' }, { status: 404 });
  }
  try {
    if (url.pathname === '/upstream/start') {
      await startUpstream();
      return Response.json({ ok: true });
    }
    if (url.pathname === '/upstream/stop') {
      await stopUpstream();
      return Response.json({ ok: true });
    }
    if (url.pathname === '/jobs') {
      const body = (await request.json()) as { queue?: unknown };
      if (!validQueueName(body.queue)) {
        return Response.json({ ok: false, error: 'Invalid queue' }, { status: 400 });
      }
      return Response.json({ ok: true, id: await enqueue(body.queue) });
    }
    return Response.json({ ok: false, error: 'Not found' }, { status: 404 });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

function spawnDashboard(): Child {
  return Bun.spawn(['bun', 'scripts/serve.ts'], {
    cwd: repository,
    env: {
      ...process.env,
      AGENT_CONFIG_PATH: join(scratch, 'agent-config.json'),
      AGENT_ALLOWED_HOSTS: '',
      AGENT_ALLOWED_ORIGINS: '',
      AGENT_PORT: String(E2E_AGENT_PORT),
      AGENT_TOKEN: '',
      BASE_PATH: E2E_BASE_PATH,
      BIND_ADDR: E2E_LOOPBACK_HOST,
      BUNQUEUE_DATA_PATH: database,
      BUNQUEUE_MANAGED: '0',
      BUNQUEUE_TOKEN: '',
      BUNQUEUE_URL: `http://${E2E_LOOPBACK_HOST}:${E2E_HTTP_PORT}`,
      HTTP_PORT: String(E2E_HTTP_PORT),
      PORT: String(E2E_DASHBOARD_PORT),
      TCP_PORT: String(E2E_TCP_PORT),
      TRUST_PROXY: '0',
    },
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
  });
}

async function cleanup(): Promise<void> {
  stopping = true;
  const activeDashboard = dashboard;
  dashboard = null;
  const settled = await Promise.allSettled([terminate(activeDashboard), stopUpstream()]);
  const failures = settled.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  );
  try {
    await rm(scratch, { recursive: true, force: true });
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Browser E2E runtime cleanup failed');
  }
}

let control: ReturnType<typeof Bun.serve> | null = null;

try {
  control = Bun.serve({
    hostname: E2E_LOOPBACK_HOST,
    port: E2E_CONTROL_PORT,
    fetch: controlRequest,
  });
  await startUpstream();
  await enqueue(E2E_SEED_QUEUE);
  dashboard = spawnDashboard();
  await waitForHttp(`${E2E_APP_URL}/`, dashboard, 'dashboard');
  void dashboard.exited.then((code) => {
    if (stopping) return;
    console.error(`Dashboard exited unexpectedly with ${code}`);
    exitCode = code || 1;
    resolveExit();
  });
  console.log(`Browser E2E runtime ready at ${E2E_APP_URL}/`);
  process.once('SIGINT', resolveExit);
  process.once('SIGTERM', resolveExit);
  await exitRequested;
} catch (error) {
  exitCode = 1;
  console.error(error);
} finally {
  control?.stop(true);
  try {
    await cleanup();
  } catch (error) {
    exitCode = 1;
    console.error(error);
  }
  process.exitCode = exitCode;
}
