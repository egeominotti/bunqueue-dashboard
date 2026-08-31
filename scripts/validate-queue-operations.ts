import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Queue, Worker, type Job } from 'bunqueue/client';
import type { ServerConfig } from '../agent/manager';
import { QueueOperationsRuntime } from '../agent/queue/runtime';
import { assert, freePort, waitForServer } from './flowRuntimeSupport';

const root = await mkdtemp(join(tmpdir(), 'bunqueue-dashboard-queue-operations-'));
const httpPort = await freePort();
const tcpPort = await freePort();
const config: ServerConfig = {
  command: 'local queue operations validation',
  httpPort,
  tcpPort,
  dataPath: join(root, 'bunqueue.db'),
  extraEnv: { AUTH_TOKENS: '' },
};
const connection = { host: '127.0.0.1', port: tcpPort, poolSize: 1 };
const server = Bun.spawn(['bun', resolve('node_modules/bunqueue/dist/cli/index.js'), 'start'], {
  env: {
    ...process.env,
    HTTP_PORT: String(httpPort),
    TCP_PORT: String(tcpPort),
    BUNQUEUE_DATA_PATH: config.dataPath,
    AUTH_TOKENS: '',
  },
  stdout: 'pipe',
  stderr: 'pipe',
});
const runtime = new QueueOperationsRuntime();
const queueName = `queue-operations-${Date.now()}`;
const queue = new Queue(queueName, { autoBatch: { enabled: false }, connection });
const workers: Worker[] = [];
let releaseActive: () => void = () => undefined;

try {
  await waitForServer(httpPort, server);
  await queue.waitUntilReady();
  await validateLimits();
  await validateDeduplication();
  const failedJobId = await validateMaxedAndMetrics();
  await validateDlqRemoval(failedJobId);
  await validateEventTrim();
  console.log(
    JSON.stringify(
      {
        bunqueue: '2.9.0',
        queue: queueName,
        verified: [
          'getGlobalRateLimit',
          'getGlobalConcurrency',
          'getRateLimitTtl',
          'isMaxed',
          'getDeduplicationJobId',
          'removeDeduplicationKey',
          'removeDlqJob',
          'getMetrics',
          'trimEvents',
        ],
      },
      null,
      2
    )
  );
} finally {
  releaseActive();
  await Promise.all(workers.map((worker) => worker.close(true).catch(() => undefined)));
  await runtime.close().catch(() => undefined);
  try {
    queue.close();
  } catch {
    // Continue terminating the disposable server even if transport teardown already ran.
  }
  server.kill('SIGTERM');
  await Promise.race([server.exited, Bun.sleep(5_000)]);
  if (server.exitCode === null) {
    server.kill('SIGKILL');
    await Promise.race([server.exited, Bun.sleep(2_000)]);
  }
  await rm(root, { recursive: true, force: true });
}

async function validateLimits(): Promise<void> {
  await queue.setGlobalRateLimitAsync(5, 60_000);
  await queue.setGlobalConcurrencyAsync(1);
  const configured = await runtime.limits(config, queueName);
  assert(configured.rateLimit?.max === 5, 'rate-limit maximum was not readable');
  assert(configured.rateLimit?.duration === 60_000, 'rate-limit duration was not readable');
  assert(configured.concurrency === 1, 'global concurrency was not readable');

  await queue.rateLimit(5_000);
  const temporary = await runtime.limits(config, queueName);
  assert(temporary.rateLimitTtl > 0, 'temporary rate-limit TTL was not observable');
  assert(temporary.rateLimitTtl <= 5_000, 'temporary rate-limit TTL exceeded its lease');
  await queue.removeGlobalRateLimitAsync();
}

async function validateDeduplication(): Promise<void> {
  const deduplicationId = `invoice:${Date.now()}`;
  const job = await queue.add(
    'deduplicated',
    { source: 'dashboard-e2e' },
    { delay: 60_000, deduplication: { id: deduplicationId } }
  );
  assert(
    (await runtime.deduplicationJobId(config, queueName, deduplicationId)) === job.id,
    'deduplication owner was not readable'
  );
  assert(
    (await runtime.removeDeduplicationKey(config, queueName, deduplicationId)) === 1,
    'deduplication key removal was not acknowledged'
  );
  assert(
    (await runtime.deduplicationJobId(config, queueName, deduplicationId)) === null,
    'removed deduplication key remained visible'
  );
}

async function validateMaxedAndMetrics(): Promise<string> {
  const activeGate = new Promise<void>((resolveGate) => {
    releaseActive = resolveGate;
  });
  const worker = new Worker(
    queueName,
    async (job: Job) => {
      if (job.name === 'fail') throw new Error('intentional queue-operations E2E failure');
      if (job.name === 'occupy') await activeGate;
      return { processed: job.id };
    },
    { concurrency: 1, connection }
  );
  workers.push(worker);
  worker.on('error', () => undefined);
  await worker.waitUntilReady();
  const active = await queue.add('occupy', { source: 'dashboard-e2e' });
  await waitForState(active.id, 'active');
  assert((await runtime.limits(config, queueName)).maxed, 'active global slot was not reported maxed');
  releaseActive();
  await waitForState(active.id, 'completed');
  assert(!(await runtime.limits(config, queueName)).maxed, 'released global slot remained maxed');

  const failed = await queue.add('fail', { source: 'dashboard-e2e' });
  await waitForState(failed.id, 'failed');
  await assertMetric('completed');
  await assertMetric('failed');
  return failed.id;
}

async function validateDlqRemoval(jobId: string): Promise<void> {
  assert(await dlqContains(jobId), 'failed job was not visible in the DLQ before removal');
  assert(
    await runtime.removeDlqJob(config, queueName, jobId),
    'DLQ job removal was not acknowledged'
  );
  assert(!(await dlqContains(jobId)), 'removed DLQ job remained visible');
  assert(
    !(await runtime.removeDlqJob(config, queueName, jobId)),
    'second DLQ job removal was not idempotently reported as absent'
  );
}

async function dlqContains(jobId: string): Promise<boolean> {
  const response = await fetch(
    `http://127.0.0.1:${httpPort}/queues/${encodeURIComponent(queueName)}/dlq?limit=100&offset=0`
  );
  assert(response.ok, `DLQ inspection returned HTTP ${response.status}`);
  const body = (await response.json()) as { entries?: Array<{ job?: { id?: string } }> };
  assert(Array.isArray(body.entries), 'DLQ inspection returned a malformed entries list');
  return body.entries.some((entry) => entry.job?.id === jobId);
}

async function assertMetric(type: 'completed' | 'failed'): Promise<void> {
  const metrics = await runtime.metrics(config, queueName, type, 0, -1);
  assert(metrics.meta.count >= 1, `${type} terminal count was not recorded`);
  assert(metrics.data.reduce((sum, value) => sum + value, 0) >= 1, `${type} bucket was empty`);
}

async function validateEventTrim(): Promise<void> {
  const before = await runtime.metrics(config, queueName, 'completed', 0, -1);
  const removed = await runtime.trimEvents(config, queueName, 1);
  assert(removed > 0, 'event journal trim removed no lifecycle entries');
  const after = await runtime.metrics(config, queueName, 'completed', 0, -1);
  assert(after.meta.count === before.meta.count, 'event trimming changed durable metric totals');
}

async function waitForState(id: string, expected: 'active' | 'completed' | 'failed'): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((await queue.getJobState(id)) === expected) return;
    await Bun.sleep(25);
  }
  throw new Error(`Job ${id} did not reach ${expected}`);
}
