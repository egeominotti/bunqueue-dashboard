import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { bqFlowOperationsRepository } from '../src/features/flows/infrastructure/bqFlowOperationsRepository';

interface CapturedRequest {
  path: string;
  method: string;
  body: unknown;
  authorization: string | null;
}

const originalFetch = globalThis.fetch;
let requests: CapturedRequest[] = [];

beforeEach(() => {
  requests = [];
  useConnectionStore.setState({
    baseUrl: 'http://server.test',
    token: '',
    agentToken: 'agent-secret',
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    requests.push({
      path: `${url.pathname}${url.search}`,
      method: request.method,
      body: request.body ? await request.json() : undefined,
      authorization: request.headers.get('authorization'),
    });
    return Response.json({ ok: true, result: null });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  useConnectionStore.setState({ baseUrl: '/api', token: '', agentToken: '' });
});

describe('Flow operations client adapter', () => {
  test('maps every repository operation to a target-pinned agent request', async () => {
    const target = { id: 'child-1', queueName: 'orders' };
    await bqFlowOperationsRepository.create('addTree', { root: { queueName: 'orders' } });
    await bqFlowOperationsRepository.getFlow({ ...target, depth: 3, maxChildren: 7 });
    await bqFlowOperationsRepository.inspect(target, 'getDependencies');
    await bqFlowOperationsRepository.getParentResult('parent-1');
    await bqFlowOperationsRepository.getParentResults(['parent-1', 'parent-2']);
    await bqFlowOperationsRepository.waitUntilFinished(target, 60_000);
    await bqFlowOperationsRepository.mutate(target, 'promote');
    await bqFlowOperationsRepository.mutate(target, 'updateProgress', { progress: 50 });

    expect(requests.map((request) => request.path)).toEqual([
      '/flows/create?target=http%3A%2F%2Fserver.test',
      '/flows/tree?id=child-1&queueName=orders&target=http%3A%2F%2Fserver.test&depth=3&maxChildren=7',
      '/flows/jobs/child-1/getDependencies?queueName=orders&target=http%3A%2F%2Fserver.test',
      '/flows/results?target=http%3A%2F%2Fserver.test',
      '/flows/results?target=http%3A%2F%2Fserver.test',
      '/flows/jobs/child-1/waitUntilFinished?queueName=orders&target=http%3A%2F%2Fserver.test&ttl=60000',
      '/flows/jobs/child-1/promote?queueName=orders&target=http%3A%2F%2Fserver.test',
      '/flows/jobs/child-1/updateProgress?queueName=orders&target=http%3A%2F%2Fserver.test',
    ]);
    expect(requests.map((request) => request.method)).toEqual([
      'POST',
      'GET',
      'GET',
      'POST',
      'POST',
      'GET',
      'POST',
      'POST',
    ]);
    expect(requests.map((request) => request.body)).toEqual([
      { operation: 'addTree', root: { queueName: 'orders' } },
      undefined,
      undefined,
      { operation: 'getParentResult', parentId: 'parent-1' },
      { operation: 'getParentResults', parentIds: ['parent-1', 'parent-2'] },
      undefined,
      undefined,
      { progress: 50 },
    ]);
    expect(requests.every((request) => request.authorization === 'Bearer agent-secret')).toBe(true);
  });

  test('omits optional tree limits instead of sending undefined strings', async () => {
    await bqFlowOperationsRepository.getFlow({ id: 'root', queueName: 'orders' });
    expect(requests[0]?.path).toBe(
      '/flows/tree?id=root&queueName=orders&target=http%3A%2F%2Fserver.test'
    );
  });
});
