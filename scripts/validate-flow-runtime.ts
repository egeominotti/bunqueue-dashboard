import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Queue, Worker, type Job } from 'bunqueue/client';
import {
  createFlow,
  inspectFlowJob,
  mutateFlowJob,
  readFlow,
  readParentResults,
  waitForFlowJob,
} from '../agent/flow/service';
import type { FlowJobTarget } from '../agent/flow/types';
import type { ServerConfig } from '../agent/manager';
import {
  asRecord,
  assert,
  assertFlowChildCount,
  createFlowTarget,
  createParentChild,
  expectFailure,
  freePort,
  readJson,
  step,
  target,
  waitForServer,
} from './flowRuntimeSupport';

const root = await mkdtemp(join(tmpdir(), 'bunqueue-dashboard-flow-'));
const httpPort = await freePort();
const tcpPort = await freePort();
const config: ServerConfig = {
  command: 'local flow validation',
  httpPort,
  tcpPort,
  dataPath: join(root, 'bunqueue.db'),
  extraEnv: {},
};
const server = Bun.spawn(
  ['bun', resolve('node_modules/bunqueue/dist/cli/index.js'), 'start'],
  {
    env: {
      ...process.env,
      HTTP_PORT: String(httpPort),
      TCP_PORT: String(tcpPort),
      BUNQUEUE_DATA_PATH: config.dataPath,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  }
);
const workers: Worker[] = [];
try {
  await waitForServer(httpPort, server);
  const creations = await exerciseCreators();
  const mutable = await exerciseSafeMutations();
  await exerciseDependencyMutations();
  await exerciseRetry();
  await exerciseActiveInspection();
  await processCreatedFlows(creations.targets);
  console.log(
    JSON.stringify(
      {
        bunqueue: '2.9.2',
        createOperations: creations.operations,
        inspections: 14,
        mutations: 12,
        mutableResult: mutable,
        processedGraphs: creations.targets.length,
      },
      null,
      2
    )
  );
} finally {
  await Promise.all(workers.map((worker) => worker.close(true).catch(() => undefined)));
  server.kill('SIGTERM');
  await Promise.race([server.exited, Bun.sleep(5_000)]);
  if (server.exitCode === null) server.kill('SIGKILL');
  await rm(root, { recursive: true, force: true });
}

async function exerciseCreators() {
  const add = asRecord(
    await createFlow(config, {
      operation: 'add',
      flow: step('add-root', 'flow-add-root', {
        children: [step('add-child', 'flow-add-child')],
      }),
    })
  );
  const bulk = asRecord(
    await createFlow(config, {
      operation: 'addBulk',
      flows: [step('bulk-a', 'flow-bulk-a'), step('bulk-b', 'flow-bulk-b')],
    })
  );
  const chain = asRecord(
    await createFlow(config, {
      operation: 'addChain',
      steps: [step('chain-a', 'flow-chain-a'), step('chain-b', 'flow-chain-b')],
    })
  );
  const bulkThen = asRecord(
    await createFlow(config, {
      operation: 'addBulkThen',
      parallel: [step('parallel-a', 'flow-parallel-a'), step('parallel-b', 'flow-parallel-b')],
      final: step('parallel-final', 'flow-parallel-final'),
    })
  );
  const tree = asRecord(
    await createFlow(config, {
      operation: 'addTree',
      root: step('tree-root', 'flow-tree-root', {
        children: [step('tree-child', 'flow-tree-child')],
      }),
    })
  );
  const roots = bulk.roots as Array<Record<string, unknown>>;
  const chainIds = chain.jobIds as string[];
  const treeIds = tree.jobIds as string[];
  const targets: FlowJobTarget[] = [
    target(asRecord(add.root).id, 'flow-add-root'),
    target(roots[0]?.id, 'flow-bulk-a'),
    target(roots[1]?.id, 'flow-bulk-b'),
    target(chainIds.at(-1), 'flow-chain-b'),
    target(bulkThen.finalId, 'flow-parallel-final'),
    target(treeIds.at(-1), 'flow-tree-child'),
  ];
  const flow = asRecord(await readFlow(config, { ...targets[0], depth: 2, maxChildren: 10 }));
  assert(flow.flow !== null, 'getFlow did not return the committed graph');
  assertFlowChildCount(flow.flow, 1, 'getFlow did not honor the requested child traversal');
  const shallow = asRecord(await readFlow(config, { ...targets[0], depth: 0, maxChildren: 10 }));
  assertFlowChildCount(shallow.flow, 0, 'getFlow did not honor depth 0');
  return {
    operations: [add.operation, bulk.operation, chain.operation, bulkThen.operation, tree.operation],
    targets,
  };
}

async function exerciseSafeMutations(): Promise<unknown> {
  const queue = new Queue('flow-mutable', { connection: connection() });
  const added = await queue.add('mutable', { source: 'dashboard-e2e' }, {
    delay: 60_000,
    priority: 10,
    deduplication: { id: 'flow-e2e' },
  });
  await queue.close();
  const job = target(added.id, 'flow-mutable');
  assert(await matches(job, 'isDelayed'), 'delayed Flow job was not detected');
  await expectFailure(
    () => mutateFlowJob(config, job, 'updateProgress', { progress: 1 }),
    'inactive Flow progress update unexpectedly succeeded'
  );
  await mutateFlowJob(config, job, 'updateData', { data: { changed: true } });
  await mutateFlowJob(config, job, 'changeDelay', { delay: 45_000 });
  await mutateFlowJob(config, job, 'changePriority', { priority: 3, lifo: false });
  const deduplication = asRecord(await mutateFlowJob(config, job, 'removeDeduplicationKey', {}));
  assert(deduplication.removed === true, 'Flow Job deduplication key was not removed');
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  await startWorker('flow-mutable', async (activeJob) => {
    await gate;
    return defaultProcessor(activeJob);
  });
  await mutateFlowJob(config, job, 'promote', {});
  await waitForState(job, 'active');
  await mutateFlowJob(config, job, 'updateProgress', { progress: 42, message: 'e2e' });
  const numericProgress = await readJson(httpPort, `/jobs/${encodeURIComponent(job.id)}/progress`);
  assert(
    numericProgress.progress === 42 && numericProgress.message === 'e2e',
    'numeric Flow progress was not persisted'
  );
  const objectProgress = { stage: 'hydrate', completed: 4, total: 10 };
  await mutateFlowJob(config, job, 'updateProgress', { progress: objectProgress });
  await mutateFlowJob(config, job, 'log', { message: 'flow mutation e2e' });
  await mutateFlowJob(config, job, 'clearLogs', { keepLogs: 1 });
  const progress = await readJson(httpPort, `/jobs/${encodeURIComponent(job.id)}/progress`);
  const logs = asRecord((await readJson(httpPort, `/jobs/${encodeURIComponent(job.id)}/logs`)).data);
  assert(
    progress.progress === 0 && progress.message === JSON.stringify(objectProgress),
    'object Flow progress did not follow the Bunqueue 2.9.2 wire contract'
  );
  assert(logs.count === 1, 'Flow clearLogs did not preserve keepLogs');
  const json = asRecord(await inspectFlowJob(config, job, 'toJSON'));
  const raw = asRecord(await inspectFlowJob(config, job, 'asJSON'));
  assert(json.job && raw.job, 'Flow serialization methods returned no job');
  const waiting = await createFlowTarget(config, 'waiting', 'flow-waiting');
  assert(await matches(waiting, 'isWaiting'), 'waiting Flow job was not detected');
  await mutateFlowJob(config, waiting, 'remove', {});
  release();
  const finished = asRecord(await waitForFlowJob(config, job, 10_000));
  assert(await matches(job, 'isCompleted'), 'Flow wait did not observe completion');
  const single = asRecord(
    await readParentResults(config, { operation: 'getParentResult', parentId: job.id })
  );
  const many = asRecord(
    await readParentResults(config, { operation: 'getParentResults', parentIds: [job.id] })
  );
  assert(single.value !== undefined && Array.isArray(many.entries), 'Flow results were not readable');

  const removable = await createFlowTarget(config, 'removable', 'flow-removable', { delay: 60_000 });
  await mutateFlowJob(config, removable, 'remove', {});
  await expectFailure(() => inspectFlowJob(config, removable, 'getState'), 'removed job remained readable');
  return finished.value;
}

async function exerciseDependencyMutations(): Promise<void> {
  const first = await createParentChild(config, 'detach', 'flow-detach-parent', 'flow-detach-child');
  assert(await matches(first.parent, 'isWaitingChildren'), 'parent was not waiting for its child');
  const dependencies = asRecord(await inspectFlowJob(config, first.parent, 'getDependencies'));
  const counts = asRecord(await inspectFlowJob(config, first.parent, 'getDependenciesCount'));
  assert(dependencies.dependencies && counts.counts, 'dependency inspection returned no data');
  await inspectFlowJob(config, first.parent, 'getChildrenValues');
  await inspectFlowJob(config, first.parent, 'getFailedChildrenValues');
  await inspectFlowJob(config, first.parent, 'getIgnoredChildrenFailures');
  await mutateFlowJob(config, first.child, 'removeChildDependency', {});

  const second = await createParentChild(config, 'prune', 'flow-prune-parent', 'flow-prune-child');
  await mutateFlowJob(config, second.parent, 'removeUnprocessedChildren', {});
  await expectFailure(
    () => inspectFlowJob(config, second.child, 'getState'),
    'unprocessed child remained readable after removal'
  );
}

async function exerciseRetry(): Promise<void> {
  let attempts = 0;
  await startWorker('flow-retry', async () => {
    attempts++;
    if (attempts === 1) throw new Error('intentional first failure');
    return { retried: true };
  });
  const job = await createFlowTarget(config, 'retry', 'flow-retry', { attempts: 1 });
  await waitForState(job, 'failed');
  assert(await matches(job, 'isFailed'), 'failed Flow job was not detected');
  await mutateFlowJob(config, job, 'retry', {});
  const result = asRecord(await waitForFlowJob(config, job, 10_000));
  assert(asRecord(result.value).retried === true, 'Flow retry did not complete');
}

async function exerciseActiveInspection(): Promise<void> {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  await startWorker('flow-active', async () => {
    await gate;
    return { released: true };
  });
  const job = await createFlowTarget(config, 'active', 'flow-active');
  await waitForState(job, 'active');
  assert(await matches(job, 'isActive'), 'active Flow job was not detected');
  release();
  await waitForFlowJob(config, job, 10_000);
}

async function processCreatedFlows(targets: FlowJobTarget[]): Promise<void> {
  await startWorkers([
    'flow-add-root', 'flow-add-child', 'flow-bulk-a', 'flow-bulk-b',
    'flow-chain-a', 'flow-chain-b', 'flow-parallel-a', 'flow-parallel-b',
    'flow-parallel-final', 'flow-tree-root', 'flow-tree-child',
  ]);
  await Promise.all(targets.map((item) => waitForFlowJob(config, item, 15_000)));
}

async function startWorkers(queueNames: string[]): Promise<void> {
  await Promise.all(queueNames.map((name) => startWorker(name, defaultProcessor)));
}
async function startWorker(queueName: string, processor: (job: Job) => Promise<unknown>) {
  const worker = new Worker(queueName, processor, { connection: connection() });
  worker.on('error', (error) => console.error(`[${queueName}] ${error.message}`));
  workers.push(worker);
  await worker.waitUntilReady();
}

async function defaultProcessor(job: Job) {
  return { processed: true, name: job.name, queue: job.queueName };
}
function connection() {
  return { host: '127.0.0.1', port: tcpPort };
}

async function matches(targetValue: FlowJobTarget, operation: Parameters<typeof inspectFlowJob>[2]) {
  return asRecord(await inspectFlowJob(config, targetValue, operation)).matches === true;
}

async function waitForState(targetValue: FlowJobTarget, expected: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = asRecord(await inspectFlowJob(config, targetValue, 'getState'));
    if (result.state === expected) return;
    await Bun.sleep(25);
  }
  throw new Error(`Timed out waiting for Flow job ${targetValue.id} to become ${expected}`);
}
