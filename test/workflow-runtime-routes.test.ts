import { describe, expect, test } from 'bun:test';
import type { ServerConfig } from '../agent/manager';
import type { WorkflowRuntimePort, WorkflowRuntimeStatus } from '../agent/workflow/runtime';
import { routeWorkflowRuntimeRequest } from '../agent/workflow/runtimeRoutes';

const config: ServerConfig = {
  command: 'bunqueue',
  httpPort: 6790,
  tcpPort: 6789,
  dataPath: '/tmp/runtime-not-used.db',
  extraEnv: { BUNQUEUE_WORKFLOW_MODULE: '/tmp/workflows.ts' },
};

describe('Workflow runtime route boundary', () => {
  test('exposes runtime status while stopped without activating it', async () => {
    const calls: string[] = [];
    const runtime = fakeRuntime({
      status: async (_config, activate) => {
        calls.push(`status:${activate}`);
        return { configured: true, ready: false, workflowNames: [] };
      },
    });
    const response = await route('/workflows/runtime', 'GET', runtime, false);
    expect(response?.body).toEqual({
      ok: true,
      result: { configured: true, ready: false, workflowNames: [] },
    });
    expect(calls).toEqual(['status:false']);
  });

  test('wires start, signal, recovery, compensation, archive and cleanup', async () => {
    const calls: string[] = [];
    const runtime = fakeRuntime({
      start: async (_config, name) => {
        calls.push(`start:${name}`);
        return { id: 'run-1' };
      },
      signal: async (_config, id, event) => {
        calls.push(`signal:${id}:${event}`);
      },
      recover: async () => {
        calls.push('recover');
        return { total: 1 };
      },
      resumeCompensation: async (_config, id) => {
        calls.push(`resume:${id}`);
      },
      abandonCompensation: async (_config, id) => {
        calls.push(`abandon:${id}`);
      },
      archive: async (_config, age, states) => {
        calls.push(`archive:${age}:${states.join(',')}`);
        return 2;
      },
      cleanup: async (_config, age, states) => {
        calls.push(`cleanup:${age}:${states.join(',')}`);
        return 3;
      },
    });
    await route('/workflows/start', 'POST', runtime, true, {
      workflowName: 'checkout',
      input: {},
    });
    await route('/workflows/run%2F1/signal', 'POST', runtime, true, { event: 'approved' });
    await route('/workflows/recover', 'POST', runtime, true);
    await route('/workflows/run-1/resume-compensation', 'POST', runtime, true);
    await route('/workflows/run-2/abandon-compensation', 'POST', runtime, true);
    await route('/workflows/archive', 'POST', runtime, true, {
      maxAgeMs: 1000,
      states: ['completed'],
    });
    await route('/workflows/cleanup', 'POST', runtime, true, {
      maxAgeMs: 2000,
      states: ['failed'],
    });
    expect(calls).toEqual([
      'start:checkout',
      'signal:run/1:approved',
      'recover',
      'resume:run-1',
      'abandon:run-2',
      'archive:1000:completed',
      'cleanup:2000:failed',
    ]);
  });

  test('fails closed for remote targets, stopped servers and non-terminal maintenance', async () => {
    const runtime = fakeRuntime();
    await expect(
      route('/workflows/start', 'POST', runtime, true, { workflowName: 'x' }, 'https://remote.test')
    ).rejects.toThrow('does not match the agent-managed Bunqueue server');
    await expect(
      route('/workflows/start', 'POST', runtime, false, { workflowName: 'x' })
    ).rejects.toThrow('Start the managed Bunqueue server');
    await expect(
      route('/workflows/cleanup', 'POST', runtime, true, {
        maxAgeMs: 0,
        states: ['running'],
      })
    ).rejects.toThrow('only terminal');
    await expect(
      route('/workflows/start', 'POST', runtime, true, { workflowName: 'x', extra: true })
    ).rejects.toThrow('Unknown workflow control option');
  });
});

function route(
  path: string,
  method: string,
  runtime: WorkflowRuntimePort,
  running: boolean,
  body?: unknown,
  target = '/api'
) {
  const request = new Request(`http://agent${path}?target=${encodeURIComponent(target)}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
  });
  return routeWorkflowRuntimeRequest(request, path, method, config, runtime, running);
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
