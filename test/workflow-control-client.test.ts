import { afterEach, describe, expect, test } from 'bun:test';
import { bqWorkflowControlRepository as repository } from '../src/features/workflows/infrastructure/bqWorkflowControlRepository';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('Workflow control client contract', () => {
  test('maps every command to the agent and preserves target, IDs and payloads', async () => {
    const calls: Array<{ url: URL; init?: RequestInit }> = [];
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input));
      calls.push({ url, init });
      const path = url.pathname;
      if (path.endsWith('/runtime')) return envelope(readyStatus);
      if (path.endsWith('/runtime/reload')) return envelope(readyStatus);
      if (path.endsWith('/start')) {
        return envelope({ run: { id: 'run-1', workflowName: 'checkout' } });
      }
      if (path.endsWith('/recover')) {
        return envelope({ recovered: { running: 1, waiting: 2, compensating: 3, total: 6 } });
      }
      if (path.endsWith('/archive')) return envelope({ affected: 4 });
      if (path.endsWith('/cleanup')) return envelope({ affected: 5 });
      return envelope({ applied: true });
    }) as typeof fetch;

    expect(await repository.status()).toEqual(readyStatus);
    expect(await repository.reload()).toEqual(readyStatus);
    expect(await repository.start('checkout', { order: 7 })).toEqual({
      id: 'run-1',
      workflowName: 'checkout',
    });
    await repository.signal('run/1', 'approved', { actor: 'ops' });
    expect(await repository.recover()).toEqual({
      running: 1,
      waiting: 2,
      compensating: 3,
      total: 6,
    });
    await repository.resumeCompensation('run/2');
    await repository.abandonCompensation('run/3');
    expect(await repository.archive(1000, ['completed'])).toBe(4);
    expect(await repository.cleanup(2000, ['failed'])).toBe(5);

    expect(calls).toHaveLength(9);
    expect(calls.every(({ url }) => url.searchParams.get('target') === '/api')).toBeTrue();
    expect(calls.map(({ url }) => url.pathname)).toEqual([
      '/workflows/runtime',
      '/workflows/runtime/reload',
      '/workflows/start',
      '/workflows/run%2F1/signal',
      '/workflows/recover',
      '/workflows/run%2F2/resume-compensation',
      '/workflows/run%2F3/abandon-compensation',
      '/workflows/archive',
      '/workflows/cleanup',
    ]);
    expect(bodyOf(calls[2])).toEqual({ workflowName: 'checkout', input: { order: 7 } });
    expect(bodyOf(calls[3])).toEqual({ event: 'approved', payload: { actor: 'ops' } });
    expect(bodyOf(calls[7])).toEqual({ maxAgeMs: 1000, states: ['completed'] });
    expect(bodyOf(calls[8])).toEqual({ maxAgeMs: 2000, states: ['failed'] });
  });
});

const readyStatus = {
  configured: true,
  ready: true,
  moduleName: 'workflows.ts',
  workflowNames: ['checkout'],
};

function envelope(result: unknown): Response {
  return Response.json({ ok: true, result });
}

function bodyOf(call: { init?: RequestInit }): unknown {
  return JSON.parse(String(call.init?.body));
}
