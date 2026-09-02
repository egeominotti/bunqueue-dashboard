import { assert } from './flowRuntimeSupport';
import { assertPostgresSchemaVersion } from './postgresFleetMigration';
import type { NodeRuntime } from './postgresFleetNode';

export async function assertPostgresSchema20(container: string, database: string): Promise<void> {
  await assertPostgresSchemaVersion(container, database, 20);
}

export async function validatePostgresFleetGroups(
  nodes: readonly NodeRuntime[],
  queue: string
): Promise<void> {
  assert(nodes.length >= 3, 'Group fleet validation needs three brokers');
  const groupId = `tenant-${Date.now()}`;
  const grouped = await serverRequest(nodes[0], `/queues/${queue}/jobs/bulk`, {
    method: 'POST',
    body: JSON.stringify({
      jobs: [
        { name: 'group-seven', data: {}, groupId, groupMaxSize: 2, priority: 7 },
        { name: 'group-two', data: {}, groupId, groupMaxSize: 2, priority: 2 },
      ],
    }),
  });
  assert(Array.isArray(grouped.ids) && grouped.ids.length === 2, 'Grouped batch was not admitted');
  await expectServerFailure(
    nodes[1],
    `/queues/${queue}/jobs/bulk`,
    {
      method: 'POST',
      body: JSON.stringify({
        jobs: [{ name: 'group-overflow', data: {}, groupId, groupMaxSize: 2, priority: 0 }],
      }),
    },
    'maximum size of 2'
  );

  const groupPath = (node: NodeRuntime) =>
    `/queue-operations/${queue}/groups?${new URLSearchParams({
      target: `http://127.0.0.1:${node.httpPort}`,
      groupId,
      start: '0',
      end: '10',
    })}`;
  const group = await waitForAgentJson(nodes[2], groupPath(nodes[2]), (body) => {
    const snapshot = body.group as { jobs?: unknown; priorityCounts?: Record<string, unknown> };
    return snapshot?.jobs === 2 && snapshot.priorityCounts?.['2'] === 1;
  });
  assert(
    (group.group as { priorityCounts?: Record<string, number> }).priorityCounts?.['7'] === 1,
    'Broker C did not expose all group priority counts'
  );

  await mutateGroup(nodes[0], queue, groupId, 'pause');
  await waitForAgentJson(
    nodes[2],
    groupPath(nodes[2]),
    (body) => (body.group as { paused?: unknown } | undefined)?.paused === true
  );
  await mutateGroup(nodes[1], queue, groupId, 'resume');
  await waitForAgentJson(
    nodes[0],
    groupPath(nodes[0]),
    (body) => (body.group as { paused?: unknown } | undefined)?.paused === false
  );
}

async function mutateGroup(
  node: NodeRuntime,
  queue: string,
  groupId: string,
  operation: 'pause' | 'resume'
): Promise<void> {
  const target = encodeURIComponent(`http://127.0.0.1:${node.httpPort}`);
  await agentRequest(node, `/queue-operations/${queue}/groups/${operation}?target=${target}`, {
    method: 'POST',
    body: JSON.stringify({ groupId }),
  });
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

async function expectServerFailure(
  node: NodeRuntime,
  path: string,
  init: RequestInit,
  expected: string
): Promise<void> {
  try {
    await serverRequest(node, path, init);
  } catch (error) {
    assert(message(error).includes(expected), `Unexpected server rejection: ${message(error)}`);
    return;
  }
  throw new Error(`Expected ${node.name}${path} to reject with ${expected}`);
}

const serverRequest = (node: NodeRuntime, path: string, init: RequestInit = {}) =>
  jsonRequest(`http://127.0.0.1:${node.httpPort}${path}`, node.serverToken, init);
const agentRequest = (node: NodeRuntime, path: string, init: RequestInit = {}) =>
  jsonRequest(`http://127.0.0.1:${node.agentPort}${path}`, node.agentToken, init);

async function jsonRequest(url: string, token: string, init: RequestInit = {}) {
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

const message = (value: unknown) => (value instanceof Error ? value.message : String(value));
