import { describe, expect, test } from 'bun:test';
import { ProcessManager, type ServerConfig } from '../agent/manager';
import { exactJsonBody } from '../agent/queue/validation';
import { routeControlRequest } from '../agent/server/controlRoutes';
import { routeDatabaseRequest } from '../agent/server/databaseRoutes';
import { readLimitedJsonBody } from '../agent/server/jsonBody';
import type { WorkflowRuntimePort, WorkflowRuntimeStatus } from '../agent/workflow/runtime';
import { routeWorkflowRuntimeRequest } from '../agent/workflow/runtimeRoutes';

const encoder = new TextEncoder();
const options = { scope: 'Test', maxBytes: 16, limitLabel: '16 bytes' } as const;
const config: ServerConfig = {
  command: 'bunqueue',
  httpPort: 6790,
  tcpPort: 6789,
  dataPath: '/tmp/json-body-not-used.db',
  extraEnv: {},
};

describe('bounded agent JSON bodies', () => {
  test('rejects malformed, negative and oversized Content-Length before pulling the body', async () => {
    for (const [declared, error] of [
      ['invalid', 'non-negative integer'],
      ['-1', 'non-negative integer'],
      ['17', 'exceeds 16 bytes'],
    ] as const) {
      let pulls = 0;
      const request = streamRequest([encoder.encode('{}')], { 'Content-Length': declared }, () => {
        pulls += 1;
      });
      await expect(readLimitedJsonBody(request, options)).rejects.toThrow(error);
      expect(pulls).toBe(0);
    }
  });

  test('enforces the byte cap on a chunked stream before malformed JSON can be parsed', async () => {
    let cancelled = false;
    const request = streamRequest(
      [encoder.encode('{"value":'), encoder.encode('this-is-not-json-and-is-too-large')],
      undefined,
      undefined,
      () => {
        cancelled = true;
      }
    );
    await expect(readLimitedJsonBody(request, options)).rejects.toThrow('exceeds 16 bytes');
    expect(cancelled).toBe(true);
  });

  test('reports empty, malformed JSON and invalid UTF-8 with contextual errors', async () => {
    await expect(
      readLimitedJsonBody(new Request('http://agent.test', { method: 'POST', body: '' }), options)
    ).rejects.toThrow('Test request body is required');
    await expect(
      readLimitedJsonBody(new Request('http://agent.test', { method: 'POST', body: '{' }), options)
    ).rejects.toThrow('Test request body must contain valid JSON');
    await expect(
      readLimitedJsonBody(
        new Request('http://agent.test', {
          method: 'POST',
          body: new Uint8Array([0x7b, 0xc3, 0x28, 0x7d]),
        }),
        options
      )
    ).rejects.toThrow('Test request body must use valid UTF-8');
  });

  test('rejects an oversized Workflow request before parsing or runtime side effects', async () => {
    let pulls = 0;
    let starts = 0;
    const request = streamRequest(
      [encoder.encode('{not-json')],
      { 'Content-Length': String(1024 * 1024 + 1) },
      () => {
        pulls += 1;
      },
      undefined,
      'http://agent.test/workflows/start?target=%2Fapi'
    );
    const runtime = fakeRuntime({
      start: async () => {
        starts += 1;
        return { id: 'must-not-start' };
      },
    });
    await expect(
      routeWorkflowRuntimeRequest(request, '/workflows/start', 'POST', config, runtime, true)
    ).rejects.toThrow('Workflow control request exceeds 1 MiB');
    expect(pulls).toBe(0);
    expect(starts).toBe(0);
  });

  test('applies the Queue, configuration and database endpoint-specific caps', async () => {
    await expect(
      exactJsonBody(
        new Request('http://agent.test/queue', {
          method: 'POST',
          body: '{',
          headers: { 'Content-Length': String(8 * 1024 + 1) },
        }),
        []
      )
    ).rejects.toThrow('Queue operation request exceeds 8 KiB');

    const manager = new ProcessManager();
    const before = manager.getConfig();
    await expect(
      routeControlRequest(
        new Request('http://agent.test/control/config', {
          method: 'PUT',
          body: '{',
          headers: { 'Content-Length': String(64 * 1024 + 1) },
        }),
        '/control/config',
        'PUT',
        manager,
        fakeRuntime()
      )
    ).rejects.toThrow('Agent configuration request exceeds 64 KiB');
    expect(manager.getConfig()).toEqual(before);

    await expect(
      routeDatabaseRequest(
        new Request('http://agent.test/db/query', {
          method: 'POST',
          body: '{',
          headers: { 'Content-Length': String(64 * 1024 + 1) },
        }),
        '/db/query',
        'POST',
        '/definitely/not/opened.db',
        null,
        []
      )
    ).rejects.toThrow('Database query request exceeds 64 KiB');
  });
});

function streamRequest(
  chunks: Uint8Array[],
  headers?: Record<string, string>,
  onPull?: () => void,
  onCancel?: () => void,
  url = 'http://agent.test'
): Request {
  let index = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        onPull?.();
        const chunk = chunks[index];
        index += 1;
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
      cancel() {
        onCancel?.();
      },
    },
    { highWaterMark: 0 }
  );
  return new Request(url, { method: 'POST', body, headers });
}

function fakeRuntime(overrides: Partial<WorkflowRuntimePort> = {}): WorkflowRuntimePort {
  const status: WorkflowRuntimeStatus = { configured: true, ready: true, workflowNames: [] };
  return {
    status: async () => status,
    reload: async () => status,
    start: async () => ({}),
    signal: async () => undefined,
    recover: async () => ({}),
    resumeCompensation: async () => undefined,
    abandonCompensation: async () => undefined,
    archive: async () => 0,
    cleanup: async () => 0,
    close: async () => undefined,
    ...overrides,
  };
}
