import { afterEach, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { WorkflowControlRepository } from '../src/features/workflows/application/WorkflowControlRepository';
import { WorkflowRuntimePanel } from '../src/features/workflows/ui/WorkflowRuntimePanel';
import { ensureDom, settle } from './domSetup';

ensureDom();
let unmount: (() => void) | undefined;
afterEach(() => {
  unmount?.();
  unmount = undefined;
});

test('successful manual reload clears an earlier automatic initialization failure', async () => {
  let ready = false;
  const status = () => ({
    configured: true,
    ready,
    needsInitialization: !ready,
    moduleName: 'workflow.ts',
    workflowNames: ready ? ['checkout'] : [],
  });
  const repository: WorkflowControlRepository = {
    status: async () => status(),
    initialize: async () => {
      throw new Error('Workflow module registration failed');
    },
    reload: async () => {
      ready = true;
      return status();
    },
    start: async () => ({ id: 'run-1', workflowName: 'checkout' }),
    signal: async () => undefined,
    recover: async () => ({ running: 0, waiting: 0, compensating: 0, total: 0 }),
    resumeCompensation: async () => undefined,
    abandonCompensation: async () => undefined,
    archive: async () => 0,
    cleanup: async () => 0,
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  unmount = () => {
    act(() => root.unmount());
    host.remove();
  };
  act(() => root.render(createElement(WorkflowRuntimePanel, { repository })));
  await settle(5);
  expect(host.textContent).toContain('Workflow module registration failed');
  const reload = Array.from(host.querySelectorAll('button')).find(
    (button) => button.textContent === 'Reload definitions'
  );
  expect(reload?.disabled).toBe(false);
  act(() => reload?.click());
  await settle(5);
  expect(host.textContent).toContain('Handlers loaded');
  expect(host.textContent).not.toContain('Workflow module registration failed');
  expect(host.querySelector('[role="alert"]')).toBeNull();
});
