import { describe, expect, test } from 'bun:test';
import { routeFlowRequest } from '../agent/flow/routes';
import { flowWaitTransportOptions } from '../agent/flow/service';
import { normalizeFlowProgressPayload } from '../agent/flow/validation';
import type { ServerConfig } from '../agent/manager';
import { flowWaitRequestTimeout } from '../src/features/flows/infrastructure/bqFlowOperationsRepository';
import { demoFlowResponse } from '../src/lib/demo/flows';

const config: ServerConfig = {
  command: 'bunqueue',
  httpPort: 6790,
  tcpPort: 6789,
  dataPath: '/tmp/not-used.db',
  extraEnv: {},
};

describe('Flow agent target and query boundary', () => {
  test('fails closed before TCP when the dashboard target differs from the managed server', async () => {
    const request = new Request('http://agent/flows/create?target=https%3A%2F%2Fremote.example', {
      method: 'POST',
      body: JSON.stringify({ operation: 'add', flow: {} }),
      headers: { 'Content-Type': 'application/json' },
    });
    await expect(routeFlowRequest(request, '/flows/create', 'POST', config)).rejects.toThrow(
      'does not match the agent-managed Bunqueue server'
    );
  });

  test('accepts only exact, singular bounded tree options', async () => {
    const duplicate = new Request('http://agent/flows/tree?id=a&id=b&queueName=q&target=%2Fapi');
    await expect(routeFlowRequest(duplicate, '/flows/tree', 'GET', config)).rejects.toThrow(
      'Duplicate flow option: id'
    );
    const excessive = new Request(
      'http://agent/flows/tree?id=a&queueName=q&depth=501&target=%2Fapi'
    );
    await expect(routeFlowRequest(excessive, '/flows/tree', 'GET', config)).rejects.toThrow(
      'Flow depth must be at most 500'
    );
  });

  test('rejects unknown job operations without opening a broker connection', async () => {
    const request = new Request('http://agent/flows/jobs/job-a/notReal?queueName=q&target=%2Fapi', {
      method: 'POST',
    });
    expect(await routeFlowRequest(request, '/flows/jobs/job-a/notReal', 'POST', config)).toEqual({
      status: 404,
      body: { ok: false, error: 'Unknown flow operation' },
    });
  });

  test('rejects malformed parent result bodies before opening a broker connection', async () => {
    const request = new Request('http://agent/flows/results?target=%2Fapi', {
      method: 'POST',
      body: JSON.stringify({ operation: 'getParentResults', parentIds: [] }),
      headers: { 'Content-Type': 'application/json' },
    });
    await expect(routeFlowRequest(request, '/flows/results', 'POST', config)).rejects.toThrow(
      'between 1 and 1000'
    );
  });

  test('rejects malformed job mutation payloads and wait bounds before broker access', async () => {
    const mutation = new Request(
      'http://agent/flows/jobs/job-a/changePriority?queueName=q&target=%2Fapi',
      {
        method: 'POST',
        body: JSON.stringify({ priority: -1 }),
        headers: { 'Content-Type': 'application/json' },
      }
    );
    await expect(
      routeFlowRequest(mutation, '/flows/jobs/job-a/changePriority', 'POST', config)
    ).rejects.toThrow('priority must be an integer');
    const wait = new Request(
      'http://agent/flows/jobs/job-a/waitUntilFinished?queueName=q&ttl=60001&target=%2Fapi'
    );
    await expect(
      routeFlowRequest(wait, '/flows/jobs/job-a/waitUntilFinished', 'GET', config)
    ).rejects.toThrow('ttl must be from 1 to 60000');
  });

  test('normalizes both Bunqueue 2.8.57 progress contracts without losing numeric messages', () => {
    expect(normalizeFlowProgressPayload({ progress: 42, message: 'indexing' })).toEqual({
      progress: 42,
      message: 'indexing',
    });
    expect(
      normalizeFlowProgressPayload({
        progress: { stage: 'indexing', counts: [2, 5], retrying: false, detail: null },
      })
    ).toEqual({
      progress: 0,
      message: '{"stage":"indexing","counts":[2,5],"retrying":false,"detail":null}',
    });
    expect(() =>
      normalizeFlowProgressPayload({ progress: { stage: 'indexing' }, message: 'ambiguous' })
    ).toThrow('only supported with numeric progress');
  });

  test('rejects unsafe, non-JSON, cyclic, sparse, and oversized progress objects', () => {
    const inherited = Object.assign(Object.create({ hidden: true }), { stage: 'indexing' });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const sparse: unknown[] = [];
    sparse.length = 2;
    sparse[1] = 'indexing';
    const unsafe = JSON.parse('{"constructor":{"prototype":{"polluted":true}}}');

    expect(() => normalizeFlowProgressPayload({ progress: inherited })).toThrow(
      'plain JSON objects'
    );
    expect(() => normalizeFlowProgressPayload({ progress: { stage: undefined } })).toThrow(
      'valid JSON'
    );
    expect(() => normalizeFlowProgressPayload({ progress: cyclic })).toThrow('cycles');
    expect(() => normalizeFlowProgressPayload({ progress: { values: sparse } })).toThrow(
      'dense arrays'
    );
    expect(() => normalizeFlowProgressPayload({ progress: unsafe })).toThrow(
      'unsafe property name'
    );
    expect(() => normalizeFlowProgressPayload({ progress: { text: 'x'.repeat(65_536) } })).toThrow(
      'at most 65536 bytes'
    );
  });

  test('rejects unsafe object progress at the HTTP boundary before broker access', async () => {
    const request = new Request(
      'http://agent/flows/jobs/job-a/updateProgress?queueName=q&target=%2Fapi',
      {
        method: 'POST',
        body: '{"progress":{"__proto__":{"polluted":true}}}',
        headers: { 'Content-Type': 'application/json' },
      }
    );
    await expect(
      routeFlowRequest(request, '/flows/jobs/job-a/updateProgress', 'POST', config)
    ).rejects.toThrow('unsafe property name');
  });

  test('fails fast when the managed server is stopped', async () => {
    const request = new Request('http://agent/flows/tree?id=a&queueName=q&target=%2Fapi');
    await expect(routeFlowRequest(request, '/flows/tree', 'GET', config, false)).rejects.toThrow(
      'Start the managed Bunqueue server'
    );
  });

  test('rejects unknown create and parent-result keys before broker access', async () => {
    const create = new Request('http://agent/flows/create?target=%2Fapi', {
      method: 'POST',
      body: JSON.stringify({ operation: 'add', flow: {}, typo: true }),
      headers: { 'Content-Type': 'application/json' },
    });
    await expect(routeFlowRequest(create, '/flows/create', 'POST', config)).rejects.toThrow(
      'Unknown Flow create option: typo'
    );
    const results = new Request('http://agent/flows/results?target=%2Fapi', {
      method: 'POST',
      body: JSON.stringify({ operation: 'getParentResult', parentId: 'parent', typo: true }),
      headers: { 'Content-Type': 'application/json' },
    });
    await expect(routeFlowRequest(results, '/flows/results', 'POST', config)).rejects.toThrow(
      'Unknown Flow parent result option: typo'
    );
  });

  test('rejects bodies on bodyless operations and oversized bodies before JSON parsing', async () => {
    const bodyless = new Request('http://agent/flows/jobs/job-a/retry?queueName=q&target=%2Fapi', {
      method: 'POST',
      body: '{}',
    });
    await expect(
      routeFlowRequest(bodyless, '/flows/jobs/job-a/retry', 'POST', config)
    ).rejects.toThrow('does not accept a request body');
    const oversized = new Request('http://agent/flows/create?target=%2Fapi', {
      method: 'POST',
      body: '{}',
      headers: { 'Content-Length': String(1024 * 1024 + 1) },
    });
    await expect(routeFlowRequest(oversized, '/flows/create', 'POST', config)).rejects.toThrow(
      'exceeds 1 MiB'
    );
  });

  test('keeps the maximum Flow wait alive through TCP and browser deadlines', () => {
    expect(flowWaitTransportOptions(60_000)).toEqual({ commandTimeout: 65_000, poolSize: 1 });
    expect(flowWaitRequestTimeout(60_000)).toBe(65_000);
  });

  test('applies getFlow depth and maxChildren in demo mode too', () => {
    const shallow = demoFlowResponse(['flows', 'tree'], 'GET', '?depth=0&maxChildren=2');
    const result = shallow.result as { flow: { children: unknown[] } };
    expect(result.flow.children).toEqual([]);
    const limited = demoFlowResponse(['flows', 'tree'], 'GET', '?depth=2&maxChildren=1');
    const limitedResult = limited.result as { flow: { children: unknown[] } };
    expect(limitedResult.flow.children).toHaveLength(1);
  });
});
