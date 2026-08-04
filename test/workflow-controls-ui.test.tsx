import { afterEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { WorkflowControlRepository } from '../src/features/workflows/application/WorkflowControlRepository';
import { WorkflowCompensationControls } from '../src/features/workflows/ui/WorkflowCompensationControls';
import { WorkflowMaintenancePanel } from '../src/features/workflows/ui/WorkflowMaintenancePanel';
import { WorkflowRuntimePanel } from '../src/features/workflows/ui/WorkflowRuntimePanel';
import { WorkflowSignalControl } from '../src/features/workflows/ui/WorkflowSignalControl';
import { ensureDom, settle } from './domSetup';

ensureDom();
const mounted = new Set<() => void>();

afterEach(() => {
  for (const unmount of mounted) unmount();
  mounted.clear();
});

describe('Workflow Engine controls', () => {
  test('starts a registered workflow once and wires recover and reload', async () => {
    const calls: string[] = [];
    let release: (() => void) | undefined;
    const repository = fakeRepository({
      start: (name, input) => {
        calls.push(`start:${name}:${JSON.stringify(input)}`);
        return new Promise((resolve) => {
          release = () => resolve({ id: 'run-1', workflowName: name });
        });
      },
      recover: async () => {
        calls.push('recover');
        return { running: 0, waiting: 0, compensating: 0, total: 0 };
      },
      reload: async () => {
        calls.push('reload');
        return readyStatus;
      },
    });
    const originalConfirm = window.confirm;
    window.confirm = () => true;
    try {
      const host = render(createElement(WorkflowRuntimePanel, { repository }));
      await settle(3);
      expect(host.textContent).toContain('__workflow:steps');
      expect(host.textContent).toContain('Concurrency 9');
      change(host.querySelector('[aria-label="Registered workflow"]'), 'checkout');
      const start = button(host, 'Start execution');
      act(() => {
        start.click();
        start.click();
      });
      expect(calls).toEqual(['start:checkout:{}']);
      release?.();
      await settle(3);
      click(button(host, 'Recover orphaned'));
      await settle(3);
      click(button(host, 'Reload definitions'));
      await settle(3);
      expect(calls).toEqual(['start:checkout:{}', 'recover', 'reload']);
    } finally {
      window.confirm = originalConfirm;
    }
  });

  test('sends an exact durable signal with parsed JSON payload', async () => {
    const calls: unknown[] = [];
    const repository = fakeRepository({
      signal: async (...args) => {
        calls.push(args.slice(1));
      },
    });
    const originalConfirm = window.confirm;
    window.confirm = () => true;
    try {
      const host = render(
        createElement(WorkflowSignalControl, { repository, executionId: 'run/1' })
      );
      change(host.querySelector('[aria-label="Workflow signal event"]'), 'approved');
      change(host.querySelector('[aria-label="Workflow signal payload"]'), '{"actor":"ops"}');
      click(button(host, 'Send durable signal'));
      await settle(3);
      expect(calls).toEqual([['approved', { actor: 'ops' }]]);
    } finally {
      window.confirm = originalConfirm;
    }
  });

  test('wires compensation decisions and bounded terminal maintenance', async () => {
    const calls: string[] = [];
    const repository = fakeRepository({
      resumeCompensation: async (_config) => calls.push('resume'),
      abandonCompensation: async (_config) => calls.push('abandon'),
      archive: async (age, states) => {
        calls.push(`archive:${age}:${states.join(',')}`);
        return 2;
      },
      cleanup: async (age, states) => {
        calls.push(`cleanup:${age}:${states.join(',')}`);
        return 1;
      },
    });
    const originalConfirm = window.confirm;
    window.confirm = () => true;
    try {
      const compensation = render(
        createElement(WorkflowCompensationControls, {
          repository,
          executionId: 'run-1',
          stuck: true,
        })
      );
      click(button(compensation, 'Resume compensation'));
      await settle(2);
      click(button(compensation, 'Abandon remainder'));
      await settle(2);
      const maintenance = render(createElement(WorkflowMaintenancePanel, { repository }));
      change(maintenance.querySelector('[aria-label="Workflow retention age hours"]'), '1');
      click(button(maintenance, 'Archive eligible'));
      await settle(2);
      click(button(maintenance, 'Delete eligible'));
      await settle(2);
      expect(calls).toEqual([
        'resume',
        'abandon',
        'archive:3600000:completed,failed',
        'cleanup:3600000:completed,failed',
      ]);
    } finally {
      window.confirm = originalConfirm;
    }
  });
});

const readyStatus = {
  configured: true,
  ready: true,
  moduleName: 'workflows.ts',
  workflowNames: ['checkout'],
  queueName: '__workflow:steps',
  concurrency: 9,
};

function fakeRepository(overrides: Partial<WorkflowControlRepository>): WorkflowControlRepository {
  return {
    status: async () => readyStatus,
    reload: async () => readyStatus,
    start: async (name) => ({ id: 'run', workflowName: name }),
    signal: async () => undefined,
    recover: async () => ({ running: 0, waiting: 0, compensating: 0, total: 0 }),
    resumeCompensation: async () => undefined,
    abandonCompensation: async () => undefined,
    archive: async () => 0,
    cleanup: async () => 0,
    ...overrides,
  };
}

function render(element: ReactElement): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.add(() => act(() => root.unmount()));
  act(() => root.render(element));
  return host;
}

function button(host: ParentNode, label: string): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll('button')).find((item) =>
    item.textContent?.includes(label)
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

function change(element: Element | null, value: string): void {
  if (
    !(element instanceof window.HTMLInputElement || element instanceof window.HTMLTextAreaElement)
  ) {
    throw new Error('Missing form control');
  }
  act(() => {
    const prototype =
      element.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
    const key = Object.getOwnPropertyNames(element).find((name) =>
      name.startsWith('__reactProps$')
    );
    const props = key
      ? ((element as unknown as Record<string, unknown>)[key] as {
          onChange?: (event: { target: typeof element; currentTarget: typeof element }) => void;
        })
      : undefined;
    if (!props?.onChange) throw new Error('Controlled input has no React onChange handler');
    props.onChange({ target: element, currentTarget: element });
  });
}

function click(element: HTMLButtonElement): void {
  act(() => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
}
