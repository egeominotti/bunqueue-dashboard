import type { ReactElement } from 'react';
import { useToastStore } from '../src/components/dashboard/stores/toastStore';
import type { WorkflowControlRepository } from '../src/features/workflows/application/WorkflowControlRepository';
import type { WorkflowRepository } from '../src/features/workflows/application/WorkflowRepository';
import { ArchiveDetail } from '../src/features/workflows/ui/ArchiveDetail';
import { CompensationDetail } from '../src/features/workflows/ui/CompensationDetail';
import { useWorkflowCommand } from '../src/features/workflows/ui/useWorkflowCommand';
import { WaitingDetail } from '../src/features/workflows/ui/WaitingDetail';
import { WorkflowCompensationControls } from '../src/features/workflows/ui/WorkflowCompensationControls';
import { LiveWorkflowDuration } from '../src/features/workflows/ui/WorkflowDetailState';
import { WorkflowMaintenancePanel } from '../src/features/workflows/ui/WorkflowMaintenancePanel';
import { WorkflowRuntimePanel } from '../src/features/workflows/ui/WorkflowRuntimePanel';
import { WorkflowSignalControl } from '../src/features/workflows/ui/WorkflowSignalControl';
import { renderHook, settle } from './domSetup';
import {
  act,
  click,
  createElement,
  describe,
  detail,
  expect,
  installTestHooks,
  render,
  summary,
  test,
} from './workflows-ui.helpers';

installTestHooks();

describe('Workflow UI resilience', () => {
  test('parked duration advances from the last transition without a data refresh', () => {
    let now = 4_000;
    let tick = () => {};
    const clock = {
      now: () => now,
      subscribe: (update: () => void) => {
        tick = update;
        return () => {};
      },
    };
    const { host } = render(
      createElement('span', null, createElement(LiveWorkflowDuration, { since: 1_000, clock }))
    );
    expect(host.textContent).toBe('3.0s');
    now = 65_000;
    act(() => tick());
    expect(host.textContent).toBe('1m 4s');
  });

  test('waiting, compensation, and archive retain a visibly stale snapshot', async () => {
    const cases: Array<[string, (repository: WorkflowRepository) => ReactElement]> = [
      [
        'waiting',
        (repository) =>
          createElement(WaitingDetail, {
            repository,
            controlRepository,
            id: 'waiting',
            pollIntervalMs: 5,
          }),
      ],
      [
        'compensation-stuck',
        (repository) =>
          createElement(CompensationDetail, {
            repository,
            controlRepository,
            id: 'compensation-stuck',
            pollIntervalMs: 5,
          }),
      ],
      [
        'completed',
        (repository) =>
          createElement(ArchiveDetail, {
            repository,
            id: 'completed',
            pollIntervalMs: 5,
          }),
      ],
    ];
    for (const [state, element] of cases) {
      let calls = 0;
      const repository = executionRepository(state, () => ++calls > 1);
      const view = render(element(repository));
      await settle(15);
      expect(view.host.textContent).toContain(state);
      expect(view.host.textContent).toContain('showing the last persisted snapshot');
      expect(view.host.textContent).toContain('Retry');
      view.unmount();
    }
  });

  test('runtime status failure is explicit instead of claiming no configuration', async () => {
    const repository = control({ status: async () => Promise.reject(new Error('agent offline')) });
    const { host } = render(createElement(WorkflowRuntimePanel, { repository }));
    await settle(3);
    expect(host.textContent).toContain('Status unavailable');
    expect(host.textContent).toContain('agent offline');
    expect(host.textContent).not.toContain('Not configured');
  });

  test('cleanup copy and confirmation identify the active store boundary', async () => {
    const confirmations: string[] = [];
    const original = window.confirm;
    window.confirm = (message) => {
      confirmations.push(String(message));
      return false;
    };
    try {
      const { host } = render(createElement(WorkflowMaintenancePanel, { repository: control({}) }));
      expect(host.textContent).toContain('active store only');
      click(host, 'Delete eligible');
      await settle(1);
      expect(confirmations[0]).toContain('active execution store');
      expect(confirmations[0]).toContain('Archive records are not deleted');
    } finally {
      window.confirm = original;
    }
  });

  test('void signal and compensation commands expose receipts and request fresh lists', async () => {
    const operations: string[] = [];
    let refreshes = 0;
    const repository = control({
      signal: async () => operations.push('signal'),
      resumeCompensation: async () => operations.push('resume'),
      abandonCompensation: async () => operations.push('abandon'),
    });
    clearToasts();
    const original = window.confirm;
    window.confirm = () => true;
    try {
      const signal = render(
        createElement(WorkflowSignalControl, {
          repository,
          executionId: 'run-1',
          onApplied: () => {
            refreshes += 1;
          },
        })
      );
      change(signal.host.querySelector('[aria-label="Workflow signal event"]'), 'approved');
      click(signal.host, 'Send durable signal');
      await settle(3);
      expect(signal.host.textContent).toContain('Durable signal accepted');

      const compensation = render(
        createElement(WorkflowCompensationControls, {
          repository,
          executionId: 'run-1',
          stuck: true,
          onApplied: () => {
            refreshes += 1;
          },
        })
      );
      click(compensation.host, 'Resume compensation');
      await settle(3);
      expect(compensation.host.textContent).toContain('Resume command accepted');
      click(compensation.host, 'Abandon remainder');
      await settle(3);
      expect(compensation.host.textContent).toContain('Abandon command accepted');
      expect(operations).toEqual(['signal', 'resume', 'abandon']);
      expect(refreshes).toBe(3);
      expect(useToastStore.getState().toasts.map((toast) => toast.title)).toEqual([
        'Workflow signal accepted',
        'Compensation resumed',
        'Compensation abandoned',
      ]);
    } finally {
      window.confirm = original;
      clearToasts();
    }
  });

  test('a command resolved after retarget cannot publish into the new execution', async () => {
    let resolveA: (value: unknown) => void = () => {};
    const pendingA = new Promise((resolve) => {
      resolveA = resolve;
    });
    const hook = renderHook(
      ({ scope }: { scope: string }) =>
        useWorkflowCommand({ operationGroup: 'test-retarget', scopeKey: scope }),
      { scope: 'run-a' }
    );
    act(() => void hook.result.current.run('signal-a', () => pendingA));
    expect(hook.result.current.busy).toBe('signal-a');
    hook.rerender({ scope: 'run-b' });
    expect(hook.result.current.busy).toBe('signal-a');
    await act(async () => hook.result.current.run('signal-b-blocked', async () => undefined));
    expect(hook.result.current.succeeded).toBe('');
    resolveA({ stale: true });
    await settle(2);
    expect(hook.result.current.busy).toBe('');
    expect(hook.result.current.succeeded).toBe('');
    expect(hook.result.current.result).toBeUndefined();
    await act(async () => hook.result.current.run('signal-b', async () => undefined));
    expect(hook.result.current.succeeded).toBe('signal-b');
    hook.unmount();
  });

  test('an unmounted command cannot emit a delayed success callback', async () => {
    let release: () => void = () => {};
    let successes = 0;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hook = renderHook(() =>
      useWorkflowCommand({
        operationGroup: 'test-unmount',
        scopeKey: 'run-a',
        onSucceeded: () => {
          successes += 1;
        },
      })
    );
    act(() => void hook.result.current.run('signal', () => pending));
    hook.unmount();
    release();
    await settle(2);
    expect(successes).toBe(0);
  });
});

function executionRepository(state: string, fail: () => boolean): WorkflowRepository {
  return {
    stats: async () => Promise.reject(new Error('unused')),
    list: async () => Promise.reject(new Error('unused')),
    get: async (id) => {
      if (fail()) throw new Error('workflow database busy');
      return {
        ...detail(id),
        execution: {
          ...detail(id).execution,
          ...summary(id, state as ReturnType<typeof summary>['state']),
          archivedAt: state === 'completed' ? 3_000 : undefined,
        },
      };
    },
  };
}

const controlRepository = control({});

function control(overrides: Partial<WorkflowControlRepository>): WorkflowControlRepository {
  return {
    status: async () => ({ configured: false, ready: false, workflowNames: [] }),
    reload: async () => ({ configured: false, ready: false, workflowNames: [] }),
    start: async (workflowName) => ({ id: 'run', workflowName }),
    signal: async () => undefined,
    recover: async () => ({ running: 0, waiting: 0, compensating: 0, total: 0 }),
    resumeCompensation: async () => undefined,
    abandonCompensation: async () => undefined,
    archive: async () => 0,
    cleanup: async () => 0,
    ...overrides,
  };
}

function change(element: Element | null, value: string): void {
  if (!(element instanceof window.HTMLInputElement)) throw new Error('Missing workflow input');
  act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(
      element,
      value
    );
    const key = Object.getOwnPropertyNames(element).find((name) =>
      name.startsWith('__reactProps$')
    );
    const props = key
      ? ((element as unknown as Record<string, unknown>)[key] as {
          onChange?: (event: { target: HTMLInputElement }) => void;
        })
      : undefined;
    if (!props?.onChange) throw new Error('Workflow input has no React onChange handler');
    props.onChange({ target: element });
  });
}

function clearToasts(): void {
  for (const item of useToastStore.getState().toasts) useToastStore.getState().dismiss(item.id);
}
