import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, type ReactElement } from 'react';
import {
  type ConnectionDraft,
  useConnectionStore,
} from '../src/components/dashboard/stores/connectionStore';
import { FlowCreator } from '../src/features/flows/ui/FlowCreator';
import type { WorkflowControlRepository } from '../src/features/workflows/application/WorkflowControlRepository';
import { WorkflowMaintenancePanel } from '../src/features/workflows/ui/WorkflowMaintenancePanel';
import { WorkflowRuntimePanel } from '../src/features/workflows/ui/WorkflowRuntimePanel';
import { currentControlConnectionEpoch } from '../src/lib/controlConnectionEpoch';
import { ensureDom, settle } from './domSetup';
import {
  button,
  changeControl,
  click,
  createElement,
  deferred,
  fakeRepository,
  field,
  marker,
  renderFlowUi,
  submit,
} from './flow-operation-races.helpers';

ensureDom();
const mounted = new Set<() => void>();
const originalConfirm = window.confirm;
let originalConnection: ConnectionDraft;

const CONNECTION_A = {
  baseUrl: 'http://queue-a.test',
  token: 'server-secret-a',
  agentToken: 'agent-secret-a',
};
const CONNECTION_B = {
  baseUrl: 'http://queue-b.test',
  token: 'server-secret-b',
  agentToken: 'agent-secret-b',
};
const AGENT_TOKEN_B = { ...CONNECTION_A, agentToken: CONNECTION_B.agentToken };
const SERVER_TOKEN_B = { ...CONNECTION_A, token: CONNECTION_B.token };

beforeEach(() => {
  const state = useConnectionStore.getState();
  originalConnection = {
    baseUrl: state.baseUrl,
    token: state.token,
    agentToken: state.agentToken,
  };
  setConnection(CONNECTION_A);
});

afterEach(() => {
  for (const unmount of mounted) unmount();
  mounted.clear();
  window.confirm = originalConfirm;
  setConnection(originalConnection);
});

describe('Control command connection retargeting', () => {
  test('Flow operation drops server A after URL and credential retargeting', async () => {
    const heldA = deferred<unknown>();
    const targets: ConnectionDraft[] = [];
    const repository = fakeRepository({
      create: () => {
        targets.push(connectionSnapshot());
        return targets.length === 1 ? heldA.promise : Promise.resolve(marker('fresh-flow-b'));
      },
    });
    const view = mount(createElement(FlowCreator, { repository, onOpen: () => undefined }));

    submit(view.host);
    const epochA = currentControlConnectionEpoch();
    setConnection(CONNECTION_B);
    expect(currentControlConnectionEpoch()).toBe(epochA + 1);
    submit(view.host);
    await settle(2);
    expect(targets).toEqual([CONNECTION_A, CONNECTION_B]);
    expect(view.host.textContent).toContain('fresh-flow-b');

    heldA.resolve(marker('stale-flow-a'));
    await settle(2);
    expect(view.host.textContent).toContain('fresh-flow-b');
    expect(view.host.textContent).not.toContain('stale-flow-a');
    expect(view.host.textContent).not.toContain(CONNECTION_B.agentToken);
  });

  test('Workflow runtime accepts B while a start against A is still pending', async () => {
    const heldA = deferred<{ id: string; workflowName: string }>();
    const targets: ConnectionDraft[] = [];
    const repository = workflowRepository({
      start: async (workflowName) => {
        targets.push(connectionSnapshot());
        return targets.length === 1 ? heldA.promise : { id: 'fresh-run-b', workflowName };
      },
    });
    const view = mount(createElement(WorkflowRuntimePanel, { repository }));
    await settle(3);
    changeControl(field<HTMLInputElement>(view.host, 'Registered workflow'), 'checkout');
    click(button(view.host, 'Start execution'));

    setConnection(AGENT_TOKEN_B);
    await settle(3);
    click(button(view.host, 'Start execution'));
    await settle(3);
    expect(targets).toEqual([CONNECTION_A, AGENT_TOKEN_B]);
    expect(view.host.textContent).toContain('fresh-run-b');

    heldA.resolve({ id: 'stale-run-a', workflowName: 'checkout' });
    await settle(2);
    expect(view.host.textContent).toContain('fresh-run-b');
    expect(view.host.textContent).not.toContain('stale-run-a');
    expect(view.host.textContent).not.toContain(AGENT_TOKEN_B.agentToken);
  });

  test('Workflow maintenance cannot publish an A receipt under B', async () => {
    const heldA = deferred<number>();
    const targets: ConnectionDraft[] = [];
    const repository = workflowRepository({
      archive: () => {
        targets.push(connectionSnapshot());
        return targets.length === 1 ? heldA.promise : Promise.resolve(2);
      },
    });
    window.confirm = () => true;
    const view = mount(createElement(WorkflowMaintenancePanel, { repository }));

    click(button(view.host, 'Archive eligible'));
    setConnection(SERVER_TOKEN_B);
    click(button(view.host, 'Archive eligible'));
    await settle(2);
    expect(targets).toEqual([CONNECTION_A, SERVER_TOKEN_B]);
    expect(view.host.textContent).toContain('"affected": 2');

    heldA.resolve(99);
    await settle(2);
    expect(view.host.textContent).toContain('"affected": 2');
    expect(view.host.textContent).not.toContain('"affected": 99');
    expect(view.host.textContent).not.toContain(SERVER_TOKEN_B.token);
  });
});

function mount(element: ReactElement) {
  const view = renderFlowUi(element);
  mounted.add(view.unmount);
  return view;
}

function setConnection(connection: ConnectionDraft): void {
  act(() => {
    useConnectionStore.getState().saveConnection(connection);
  });
}

function connectionSnapshot(): ConnectionDraft {
  const state = useConnectionStore.getState();
  return { baseUrl: state.baseUrl, token: state.token, agentToken: state.agentToken };
}

function workflowRepository(
  overrides: Partial<WorkflowControlRepository>
): WorkflowControlRepository {
  const status = {
    configured: true,
    ready: true,
    workflowNames: ['checkout'],
    queueName: '__workflow:steps',
    concurrency: 5,
  };
  return {
    status: async () => status,
    reload: async () => status,
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
