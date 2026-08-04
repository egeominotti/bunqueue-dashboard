import {
  FlowProducer,
  TcpConnectionPool,
  type FlowJob,
  type FlowOpts,
  type FlowStep,
  type JobNode,
} from 'bunqueue/client';
import type { ServerConfig } from '../manager';
import { managedAuthToken } from '../managedTarget';
import {
  asFlowRecord,
  assertFlowBodySize,
  assertExactFlowKeys,
  normalizeFlowProgressPayload,
  validateFlowTarget,
  validateMutationPayload,
  validateParentIds,
} from './validation';
import type { FlowInspectOperation, FlowJobTarget, FlowMutationOperation } from './types';

type CreateOperation =
  | { operation: 'add'; flow: FlowJob; options?: FlowOpts }
  | { operation: 'addBulk'; flows: FlowJob[] }
  | { operation: 'addChain'; steps: FlowStep[] }
  | { operation: 'addBulkThen'; parallel: FlowStep[]; final: FlowStep }
  | { operation: 'addTree'; root: FlowStep };

type ParentResultRequest =
  | { operation: 'getParentResult'; parentId: string }
  | { operation: 'getParentResults'; parentIds: string[] };

export async function createFlow(config: ServerConfig, input: unknown): Promise<unknown> {
  assertFlowBodySize(input);
  const request = createRequest(input);
  const producer = producerFor(config);
  try {
    switch (request.operation) {
      case 'add':
        return { operation: request.operation, root: await serializeNode(await producer.add(request.flow, request.options)) };
      case 'addBulk':
        return { operation: request.operation, roots: await Promise.all((await producer.addBulk(request.flows)).map(serializeNode)) };
      case 'addChain':
        return { operation: request.operation, ...(await producer.addChain(request.steps)) };
      case 'addBulkThen':
        return { operation: request.operation, ...(await producer.addBulkThen(request.parallel, request.final)) };
      case 'addTree':
        return { operation: request.operation, ...(await producer.addTree(request.root)) };
      default:
        throw new Error('Unknown FlowProducer create operation');
    }
  } finally {
    await producer.close();
  }
}

export async function readFlow(
  config: ServerConfig,
  target: FlowJobTarget & { depth?: number; maxChildren?: number }
): Promise<unknown> {
  validateFlowTarget(target);
  const producer = producerFor(config);
  try {
    const node = await producer.getFlow(target);
    return node ? { flow: await serializeNode(node) } : { flow: null };
  } finally {
    await producer.close();
  }
}

export async function readParentResults(config: ServerConfig, input: unknown): Promise<unknown> {
  assertFlowBodySize(input);
  const request = parentResultRequest(input);
  const producer = producerFor(config);
  try {
    if (request.operation === 'getParentResult') {
      const value = await producer.getParentResult(request.parentId);
      return { operation: request.operation, parentId: request.parentId, value };
    }
    const values = await producer.getParentResults(request.parentIds);
    return { operation: request.operation, entries: Array.from(values.entries()) };
  } finally {
    await producer.close();
  }
}

export async function inspectFlowJob(
  config: ServerConfig,
  target: FlowJobTarget,
  operation: FlowInspectOperation
): Promise<unknown> {
  const { producer, job } = await loadJob(config, target);
  try {
    switch (operation) {
      case 'getState': return { state: await job.getState() };
      case 'isWaiting': return { matches: await job.isWaiting() };
      case 'isActive': return { matches: await job.isActive() };
      case 'isDelayed': return { matches: await job.isDelayed() };
      case 'isCompleted': return { matches: await job.isCompleted() };
      case 'isFailed': return { matches: await job.isFailed() };
      case 'isWaitingChildren': return { matches: await job.isWaitingChildren() };
      case 'toJSON': return { job: job.toJSON() };
      case 'asJSON': return { job: job.asJSON() };
      case 'getChildrenValues': return { values: await job.getChildrenValues() };
      case 'getDependencies': return { dependencies: await job.getDependencies() };
      case 'getDependenciesCount': return { counts: await job.getDependenciesCount() };
      case 'getFailedChildrenValues': return { values: await job.getFailedChildrenValues() };
      case 'getIgnoredChildrenFailures': return { values: await job.getIgnoredChildrenFailures() };
      default: throw new Error('Unknown flow inspection operation');
    }
  } finally {
    await producer.close();
  }
}

export async function mutateFlowJob(
  config: ServerConfig,
  target: FlowJobTarget,
  operation: FlowMutationOperation,
  input: unknown
): Promise<unknown> {
  assertFlowBodySize(input);
  const payload = asFlowRecord(input);
  validateMutationPayload(operation, payload);
  const { producer, job } = await loadJob(config, target);
  try {
    switch (operation) {
      case 'removeChildDependency': return { removed: await job.removeChildDependency() };
      case 'removeUnprocessedChildren': await job.removeUnprocessedChildren(); break;
      case 'updateData': await job.updateData(payload.data); break;
      case 'updateProgress': await updateProgress(config, target, payload); break;
      case 'log': await job.log(payload.message as string); break;
      case 'changeDelay': await job.changeDelay(payload.delay as number); break;
      case 'changePriority': await job.changePriority({ priority: payload.priority as number, ...(payload.lifo === undefined ? {} : { lifo: payload.lifo as boolean }) }); break;
      case 'clearLogs': await job.clearLogs(payload.keepLogs as number | undefined); break;
      case 'removeDeduplicationKey': return { removed: await job.removeDeduplicationKey() };
      case 'retry': await job.retry(); break;
      case 'promote': await job.promote(); break;
      case 'remove': await job.remove(); break;
      default: throw new Error('Unknown flow mutation operation');
    }
    return { applied: true };
  } finally {
    await producer.close();
  }
}

export async function waitForFlowJob(
  config: ServerConfig,
  target: FlowJobTarget,
  ttl: number
): Promise<unknown> {
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 60_000) {
    throw new Error('Flow wait TTL must be an integer from 1 to 60000 ms');
  }
  const { producer, job } = await loadJob(config, target, flowWaitTransportOptions(ttl));
  try {
    return { value: await job.waitUntilFinished(undefined, ttl) };
  } finally {
    await producer.close();
  }
}

export function flowWaitTransportOptions(ttl: number) {
  return { commandTimeout: ttl + 5_000, poolSize: 1 as const };
}

function producerFor(
  config: ServerConfig,
  overrides?: { commandTimeout: number; poolSize: 1 }
): FlowProducer {
  return new FlowProducer({ connection: { ...connectionFor(config), ...overrides } });
}

function connectionFor(config: ServerConfig) {
  return { host: '127.0.0.1', port: config.tcpPort, token: managedAuthToken(config) };
}

async function loadJob(
  config: ServerConfig,
  target: FlowJobTarget,
  connectionOverrides?: { commandTimeout: number; poolSize: 1 }
) {
  validateFlowTarget(target);
  const producer = producerFor(config, connectionOverrides);
  try {
    const node = await producer.getFlow({ ...target, depth: 0, maxChildren: 0 });
    if (!node) throw new Error(`Flow job ${target.id} was not found in queue ${target.queueName}`);
    return { producer, job: node.job };
  } catch (error) {
    await producer.close();
    throw error;
  }
}

function createRequest(input: unknown): CreateOperation {
  const request = asFlowRecord(input);
  switch (request.operation) {
    case 'add':
      assertExactFlowKeys(request, ['operation', 'flow', 'options'], 'create');
      break;
    case 'addBulk':
      assertExactFlowKeys(request, ['operation', 'flows'], 'create');
      break;
    case 'addChain':
      assertExactFlowKeys(request, ['operation', 'steps'], 'create');
      break;
    case 'addBulkThen':
      assertExactFlowKeys(request, ['operation', 'parallel', 'final'], 'create');
      break;
    case 'addTree':
      assertExactFlowKeys(request, ['operation', 'root'], 'create');
      break;
    default:
      throw new Error('Unknown FlowProducer create operation');
  }
  return request as unknown as CreateOperation;
}

function parentResultRequest(input: unknown): ParentResultRequest {
  const request = asFlowRecord(input);
  if (request.operation === 'getParentResult') {
    assertExactFlowKeys(request, ['operation', 'parentId'], 'parent result');
    validateParentIds([request.parentId]);
  } else if (request.operation === 'getParentResults') {
    assertExactFlowKeys(request, ['operation', 'parentIds'], 'parent result');
    validateParentIds(request.parentIds);
  } else {
    throw new Error('Unknown FlowProducer parent result operation');
  }
  return request as unknown as ParentResultRequest;
}

async function updateProgress(
  config: ServerConfig,
  target: FlowJobTarget,
  payload: Record<string, unknown>
): Promise<void> {
  const wire = normalizeFlowProgressPayload(payload);
  const tcp = new TcpConnectionPool({ ...connectionFor(config), poolSize: 1 });
  try {
    const response = await tcp.send({
      cmd: 'Progress',
      id: target.id,
      progress: wire.progress,
      message: wire.message,
    });
    if (response.ok !== true) {
      throw new Error(
        typeof response.error === 'string' ? response.error : 'Flow updateProgress failed'
      );
    }
  } finally {
    tcp.close();
  }
}

async function serializeNode(node: JobNode): Promise<unknown> {
  return {
    id: String(node.job.id),
    name: node.job.name,
    queueName: node.job.queueName,
    state: await node.job.getState(),
    children: node.children ? await Promise.all(node.children.map(serializeNode)) : [],
  };
}
