import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Queue } from 'bunqueue/client';
import { managedConnection } from '../agent/managedConnection';
import type { ServerConfig } from '../agent/manager';
import { QueueOperationsRuntime } from '../agent/queue/runtime';
import { WorkflowRuntime } from '../agent/workflow/runtime';
import { createFlow, inspectFlowJob, mutateFlowJob } from '../agent/flow/service';
import { workflowExecution } from '../agent/workflows';
import { installedBunqueueVersion, verifyBunqueueVersion } from './bunqueueRuntimeVersion';
import { assert, asRecord, freePort } from './flowRuntimeSupport';

const root = await mkdtemp(join(tmpdir(), 'bunqueue-dashboard-tls-'));
const cert = join(root, 'cert.pem');
const key = join(root, 'key.pem');
const config: ServerConfig = {
  command: 'TLS validation', httpPort: await freePort(), tcpPort: await freePort(),
  dataPath: join(root, 'queue.db'),
  extraEnv: {
    AUTH_TOKENS: 'tls-validation-token', TLS_CERT_FILE: cert, TLS_KEY_FILE: key,
    BUNQUEUE_AGENT_TCP_CA_FILE: cert,
    BUNQUEUE_WORKFLOW_MODULE: resolve('test/fixtures/workflow-runtime.ts'),
  },
};
let server: ReturnType<typeof Bun.spawn> | undefined;
let queue: Queue | undefined;
const operations = new QueueOperationsRuntime();
const workflows = new WorkflowRuntime();
try {
  const certificate = Bun.spawn(['openssl', 'req', '-x509', '-newkey', 'rsa:2048',
    '-nodes', '-days', '1', '-keyout', key, '-out', cert, '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1'], { stdout: 'ignore', stderr: 'pipe' });
  if (await certificate.exited !== 0) {
    throw new Error(`TLS certificate generation failed: ${await new Response(certificate.stderr).text()}`);
  }
  server = Bun.spawn(['bun', resolve('node_modules/bunqueue/dist/cli/index.js'), 'start'], {
    env: { ...process.env, ...config.extraEnv, HTTP_PORT: String(config.httpPort),
      TCP_PORT: String(config.tcpPort), BUNQUEUE_DATA_PATH: config.dataPath },
    stdout: 'ignore', stderr: 'pipe',
  });
  await waitForTlsServer();
  const health = await (await tlsFetch('/health')).json() as { version?: unknown };
  const bunqueue = verifyBunqueueVersion(health.version, installedBunqueueVersion);

  queue = new Queue('tls-queue', { connection: managedConnection(config) });
  await queue.waitUntilReady();
  await queue.add('grouped', {}, { group: { id: 'tls-group' } });
  await operations.pauseGroup(config, 'tls-queue', 'tls-group');
  const group = await operations.group(config, 'tls-queue', 'tls-group');
  assert(group.paused, 'Queue Operations TLS readback did not observe the paused group');

  const created = asRecord(await createFlow(config, { operation: 'add', flow: {
    name: 'tls-flow', queueName: 'tls-flow', data: {}, opts: { delay: 60_000 },
  } }));
  const target = { id: String(asRecord(created.root).id), queueName: 'tls-flow' };
  await mutateFlowJob(config, target, 'changePriority', { priority: 3 });
  assert(asRecord(await inspectFlowJob(config, target, 'getState')).state === 'delayed',
    'Flow TLS inspection failed');

  assert((await workflows.status(config)).ready, 'Workflow TLS runtime is not ready');
  const started = asRecord(await workflows.start(config, 'dashboard-approval-e2e', { value: 2 }));
  const id = String(started.id);
  await waitForState(id, 'waiting');
  await workflows.signal(config, id, 'approved', { actor: 'tls-test' });
  await waitForState(id, 'completed');

  // The same self-signed broker must fail without the explicitly trusted CA.
  const untrusted = new Queue('untrusted', {
    connection: { ...managedConnection(config), tls: { rejectUnauthorized: true },
      poolSize: 1, commandTimeout: 1_000 },
  });
  try {
    let rejected = false;
    try { await untrusted.waitUntilReady(); } catch { rejected = true; }
    assert(rejected, 'Untrusted TLS certificate was accepted');
  } finally { untrusted.close(); }
  console.log(JSON.stringify({ bunqueue, tls: 'verified', bridges: ['queue', 'flow', 'workflow'],
    untrustedCertificate: 'rejected' }, null, 2));
} finally {
  await workflows.close();
  await operations.close();
  queue?.close();
  if (server) {
    server.kill('SIGTERM');
    await Promise.race([server.exited, Bun.sleep(5_000)]);
    if (server.exitCode === null) { server.kill('SIGKILL'); await server.exited; }
  }
  await rm(root, { recursive: true, force: true });
}

async function waitForState(id: string, state: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const execution = await workflowExecution(config.dataPath, id, 'active');
    if (execution?.state === state) return;
    await Bun.sleep(25);
  }
  throw new Error(`TLS workflow did not reach ${state}`);
}

function tlsFetch(path: string) {
  return fetch(`https://127.0.0.1:${config.httpPort}${path}`, {
    tls: { ca: readFileSync(cert), rejectUnauthorized: true },
    signal: AbortSignal.timeout(2_000),
  });
}

async function waitForTlsServer(): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (server?.exitCode !== null) throw new Error('TLS broker exited before readiness');
    try { if ((await tlsFetch('/ready')).ok) return; } catch {}
    await Bun.sleep(50);
  }
  throw new Error('TLS broker did not become ready');
}
