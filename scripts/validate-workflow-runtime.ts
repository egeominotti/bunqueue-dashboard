import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { ServerConfig } from '../agent/manager';
import { workflowExecution, workflowStats } from '../agent/workflows';
import { WorkflowRuntime } from '../agent/workflow/runtime';

const root = await mkdtemp(join(tmpdir(), 'bunqueue-dashboard-workflow-'));
const httpPort = await freePort();
const tcpPort = await freePort();
const dataPath = join(root, 'bunqueue.db');
const modulePath = resolve('test/fixtures/workflow-runtime.ts');
const config: ServerConfig = {
  command: 'local validation',
  httpPort,
  tcpPort,
  dataPath,
  extraEnv: {
    BUNQUEUE_WORKFLOW_MODULE: modulePath,
    BUNQUEUE_WORKFLOW_QUEUE_NAME: '__dashboard:e2e',
    BUNQUEUE_WORKFLOW_CONCURRENCY: '3',
  },
};
const child = Bun.spawn(
  ['bun', resolve('node_modules/bunqueue/dist/cli/index.js'), 'start'],
  {
    env: {
      ...process.env,
      HTTP_PORT: String(httpPort),
      TCP_PORT: String(tcpPort),
      BUNQUEUE_DATA_PATH: dataPath,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  }
);
const runtime = new WorkflowRuntime();

try {
  await waitForServer(httpPort, child);
  const status = await runtime.status(config);
  assert(status.ready, `runtime not ready: ${status.error ?? 'unknown error'}`);
  assert(status.workflowNames.length === 3, 'callback registrations were not discovered');
  assert(status.queueName === '__dashboard:e2e', 'workflow queue name was not applied');
  assert(status.concurrency === 3, 'workflow concurrency was not applied');

  const approval = (await runtime.start(config, 'dashboard-approval-e2e', { value: 21 })) as {
    id: string;
  };
  await waitForState(dataPath, approval.id, 'waiting');
  await runtime.signal(config, approval.id, 'approved', { actor: 'dashboard-e2e' });
  const completed = await waitForState(dataPath, approval.id, 'completed');
  const finish = completed.steps.finish as { result?: unknown } | undefined;
  assert(finish?.result !== undefined, 'signal workflow result was not persisted');
  assert((await runtime.archive(config, 0, ['completed'])) === 1, 'completed workflow was not archived');

  const cleaned = (await runtime.start(config, 'dashboard-instant-e2e', { value: 7 })) as {
    id: string;
  };
  await waitForState(dataPath, cleaned.id, 'completed');
  assert((await runtime.cleanup(config, 0, ['completed'])) === 1, 'terminal workflow was not cleaned');

  const resumed = (await runtime.start(config, 'dashboard-compensation-e2e', {
    decision: 'resume',
  })) as { id: string };
  await waitForState(dataPath, resumed.id, 'compensation-stuck');
  await runtime.resumeCompensation(config, resumed.id);
  const resumedFinal = await waitForState(dataPath, resumed.id, 'failed');
  assert(resumedFinal.rollbackStatus === 'completed', 'compensation resume did not finish unwind');

  const abandoned = (await runtime.start(config, 'dashboard-compensation-e2e', {
    decision: 'abandon',
  })) as { id: string };
  await waitForState(dataPath, abandoned.id, 'compensation-stuck');
  await runtime.abandonCompensation(config, abandoned.id);
  const abandonedFinal = await waitForState(dataPath, abandoned.id, 'failed');
  assert(abandonedFinal.rollbackStatus === 'stuck', 'compensation abandon did not preserve partial rollback');

  const recovered = (await runtime.recover(config)) as { total: number };
  assert(recovered.total === 0, 'recovery unexpectedly found orphaned executions');
  assert(!(await runtime.status(config, false)).ready, 'stopped runtime status remained active');
  assert((await runtime.status(config)).ready, 'runtime did not reopen after a managed restart');
  const stats = workflowStats(dataPath);
  assert(stats.archiveTotal === 1, 'archive count mismatch');
  console.log(
    JSON.stringify(
      {
        bunqueue: '2.8.57',
        approval: completed.state,
        resumedCompensation: resumedFinal.rollbackStatus,
        abandonedCompensation: abandonedFinal.rollbackStatus,
        archived: stats.archiveTotal,
        recovered: recovered.total,
        queueName: status.queueName,
        concurrency: status.concurrency,
      },
      null,
      2
    )
  );
} finally {
  await runtime.close().catch(() => undefined);
  child.kill('SIGTERM');
  await Promise.race([child.exited, Bun.sleep(5_000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
  await rm(root, { recursive: true, force: true });
}

async function waitForServer(port: number, process: ReturnType<typeof Bun.spawn>): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`Bunqueue exited with ${process.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/ready`);
      if (response.ok) return;
    } catch {
      // Process is still binding its listeners.
    }
    await Bun.sleep(50);
  }
  throw new Error('Timed out waiting for Bunqueue readiness');
}

async function waitForState(dataPath: string, id: string, expected: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const execution = workflowExecution(dataPath, id);
    if (execution?.state === expected) return execution;
    await Bun.sleep(25);
  }
  throw new Error(`Timed out waiting for workflow ${id} to become ${expected}`);
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveReady, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveReady);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a local port');
  await new Promise<void>((resolveClosed) => server.close(() => resolveClosed()));
  return address.port;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
