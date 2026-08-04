import { createServer } from 'node:net';
import { createFlow } from '../agent/flow/service';
import type { FlowJobTarget } from '../agent/flow/types';
import type { ServerConfig } from '../agent/manager';

export async function waitForServer(
  port: number,
  process: ReturnType<typeof Bun.spawn>
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`Bunqueue exited with ${process.exitCode}`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/ready`)).ok) return;
    } catch {
      // Process is still binding its listeners.
    }
    await Bun.sleep(50);
  }
  throw new Error('Timed out waiting for Bunqueue readiness');
}

export async function freePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolveReady, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolveReady);
  });
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a local port');
  await new Promise<void>((resolveClosed) => listener.close(() => resolveClosed()));
  return address.port;
}

export async function expectFailure(
  task: () => Promise<unknown>,
  message: string
): Promise<void> {
  try {
    await task();
  } catch {
    return;
  }
  throw new Error(message);
}

export async function readJson(port: number, path: string): Promise<Record<string, any>> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  assert(response.ok, `HTTP validation failed for ${path}: ${response.status}`);
  return asRecord(await response.json());
}

export function step(
  name: string,
  queueName: string,
  extra: { children?: unknown[]; opts?: Record<string, unknown> } = {}
) {
  return { name, queueName, data: { source: 'dashboard-e2e' }, ...extra };
}

export async function createFlowTarget(
  config: ServerConfig,
  name: string,
  queueName: string,
  opts?: Record<string, unknown>
): Promise<FlowJobTarget> {
  const created = asRecord(
    await createFlow(config, { operation: 'add', flow: step(name, queueName, { opts }) })
  );
  return target(asRecord(created.root).id, queueName);
}

export async function createParentChild(
  config: ServerConfig,
  label: string,
  parentQueue: string,
  childQueue: string
) {
  const created = asRecord(
    await createFlow(config, {
      operation: 'add',
      flow: step(`${label}-parent`, parentQueue, {
        children: [step(`${label}-child`, childQueue)],
      }),
    })
  );
  const rootNode = asRecord(created.root);
  const childNode = asRecord((rootNode.children as unknown[])[0]);
  return { parent: target(rootNode.id, parentQueue), child: target(childNode.id, childQueue) };
}

export function target(id: unknown, queueName: string): FlowJobTarget {
  assert(typeof id === 'string' && id.length > 0, `Flow job ID missing for ${queueName}`);
  return { id, queueName };
}

export function asRecord(value: unknown): Record<string, any> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), 'expected record');
  return value as Record<string, any>;
}

export function assertFlowChildCount(flow: unknown, expected: number, message: string): void {
  const children = asRecord(flow).children;
  assert(Array.isArray(children) && children.length === expected, message);
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
