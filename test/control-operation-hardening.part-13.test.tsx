import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { useWorkflowCommand } from '../src/features/workflows/ui/useWorkflowCommand';
import { useServerActionGuard } from '../src/lib/useServerActionGuard';
import { renderHook, settle } from './domSetup';

beforeEach(() => setConnection('http://server-a.test', 'token-a', 'agent-a'));

afterEach(() => setConnection('/api', '', ''));

describe('persistent mutation leases', () => {
  test('Workflow commands remain locked through remount and release after resolve or reject', async () => {
    for (const outcome of ['resolve', 'reject'] as const) {
      const held = deferred<unknown>();
      let calls = 0;
      const group = `workflow-remount-${outcome}`;
      const first = renderHook(() =>
        useWorkflowCommand({ operationGroup: group, scopeKey: 'execution-a' })
      );
      act(() => {
        void first.result.current.run('first', async () => {
          calls += 1;
          return held.promise;
        });
      });
      first.unmount();

      const remounted = renderHook(() =>
        useWorkflowCommand({ operationGroup: group, scopeKey: 'execution-a' })
      );
      await act(async () => {
        await remounted.result.current.run('blocked', async () => {
          calls += 1;
          return 'must-not-run';
        });
      });
      const callsBeforeSettlement = calls;
      if (outcome === 'resolve') held.resolve('old-result');
      else held.reject(new Error('request timed out'));
      await settle(2);

      expect(callsBeforeSettlement).toBe(1);
      await act(async () => {
        await remounted.result.current.run('second', async () => {
          calls += 1;
          return 'fresh-result';
        });
      });
      expect(calls).toBe(2);
      expect(remounted.result.current.succeeded).toBe('second');
      expect(remounted.result.current.result).toBe('fresh-result');
      remounted.unmount();
    }
  });

  test('a Workflow command pending on A does not block a command on B', async () => {
    const heldA = deferred<unknown>();
    let calls = 0;
    const hook = renderHook(() =>
      useWorkflowCommand({ operationGroup: 'workflow-retarget', scopeKey: 'execution' })
    );
    act(() => {
      void hook.result.current.run('server-a', async () => {
        calls += 1;
        return heldA.promise;
      });
    });
    act(() => setConnection('http://server-b.test', 'token-b', 'agent-b'));
    await act(async () => {
      await hook.result.current.run('server-b', async () => {
        calls += 1;
        return 'server-b-result';
      });
    });
    heldA.resolve('server-a-stale');
    await settle(2);

    expect(calls).toBe(2);
    expect(hook.result.current.succeeded).toBe('server-b');
    expect(hook.result.current.result).toBe('server-b-result');
    hook.unmount();
  });

  test('the Workflow lease survives the StrictMode effect probe without leaking', async () => {
    let calls = 0;
    const command = async () => {
      calls += 1;
      return `result-${calls}`;
    };
    for (let mount = 0; mount < 2; mount += 1) {
      const host = document.createElement('div');
      document.body.append(host);
      const root = createRoot(host);
      act(() => {
        root.render(
          createElement(StrictMode, null, createElement(WorkflowCommandProbe, { command }))
        );
      });
      const button = host.querySelector('button');
      if (!button) throw new Error('Missing Workflow command probe');
      act(() => button.click());
      await settle(2);
      expect(button.textContent).toBe('run');
      act(() => root.unmount());
      host.remove();
    }
    expect(calls).toBe(2);
  });

  test('server mutation locks survive remount without reviving across A to B to A', () => {
    const first = renderHook(() => useServerActionGuard('persistent-server-action'));
    const leaseA = first.result.current.begin('save');
    expect(leaseA).not.toBeNull();
    first.unmount();
    const remounted = renderHook(() => useServerActionGuard('persistent-server-action'));
    let leaseB: ReturnType<typeof remounted.result.current.begin> = null;
    let newLeaseA: ReturnType<typeof remounted.result.current.begin> = null;
    let released: ReturnType<typeof remounted.result.current.begin> = null;
    try {
      expect(remounted.result.current.begin('save')).toBeNull();
      act(() => setConnection('http://server-b.test', 'token-b', 'agent-b'));
      leaseB = remounted.result.current.begin('save');
      expect(leaseB).not.toBeNull();

      act(() => setConnection('http://server-a.test', 'token-a', 'agent-a'));
      newLeaseA = remounted.result.current.begin('save');
      expect(newLeaseA).not.toBeNull();
      leaseA?.finish();
      released = remounted.result.current.begin('save');
      expect(released).toBeNull();

      newLeaseA?.finish();
      released = remounted.result.current.begin('save');
      expect(released).not.toBeNull();
    } finally {
      leaseA?.finish();
      leaseB?.finish();
      newLeaseA?.finish();
      released?.finish();
      remounted.unmount();
    }
  });
});

function WorkflowCommandProbe({ command }: { command: () => Promise<unknown> }) {
  const operation = useWorkflowCommand({
    operationGroup: 'workflow-strict-mode',
    scopeKey: 'strict-mode',
  });
  return createElement(
    'button',
    { onClick: () => void operation.run('run', command), type: 'button' },
    operation.busy || operation.succeeded || 'idle'
  );
}

function setConnection(baseUrl: string, token: string, agentToken: string): void {
  useConnectionStore.setState({ baseUrl, token, agentToken, refreshMs: 60_000 });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, reject, resolve };
}
