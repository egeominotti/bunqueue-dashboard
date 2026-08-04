import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { act, createElement, type ReactElement } from 'react';

import { createRoot } from 'react-dom/client';

import { MemoryRouter } from 'react-router-dom';

import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';

import type { WorkflowExecutionSummary } from '../src/lib/bqTypes';

import {
  reconcileWorkflowSelection,
  type WorkflowSelection,
  Workflows,
} from '../src/pages/control/Workflows';

import { ensureDom, settle } from './domSetup';

const realFetch = globalThis.fetch;

const mounted = new Set<() => void>();

const stats = {
  available: true,
  activeTotal: 2,
  archiveTotal: 1,
  states: {
    running: 1,
    waiting: 0,
    completed: 1,
    failed: 0,
    compensating: 0,
    'compensation-stuck': 0,
  },
  workflowNames: ['checkout', 'refund'],
};

function summary(id: string, state: WorkflowExecutionSummary['state'] = 'running') {
  return {
    id,
    workflowName: id.startsWith('refund') ? 'refund' : 'checkout',
    state,
    currentNodeIndex: 0,
    createdAt: 1_000,
    updatedAt: 2_000,
  } satisfies WorkflowExecutionSummary;
}

function detail(id: string) {
  return {
    ok: true,
    execution: {
      ...summary(id),
      input: { id },
      steps: {},
      signals: {},
      resolvedSteps: [],
      decisions: {},
    },
  };
}

function render(element: ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  let active = true;
  const unmount = () => {
    if (!active) return;
    active = false;
    act(() => root.unmount());
    host.remove();
    mounted.delete(unmount);
  };
  mounted.add(unmount);
  act(() => root.render(element));
  return { host, unmount };
}

function click(host: ParentNode, label: string) {
  const button = [...host.querySelectorAll('button')].find((candidate) =>
    (candidate.textContent ?? '').includes(label)
  );
  if (!button) throw new Error(`Missing button containing ${label}`);
  act(() => button.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
}

function setSelect(element: HTMLSelectElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set?.call(
      element,
      value
    );
    element.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}

export type { ReactElement, WorkflowExecutionSummary, WorkflowSelection };
export {
  act,
  afterEach,
  beforeEach,
  click,
  createElement,
  createRoot,
  describe,
  detail,
  ensureDom,
  expect,
  MemoryRouter,
  mounted,
  realFetch,
  reconcileWorkflowSelection,
  render,
  setSelect,
  settle,
  stats,
  summary,
  test,
  useConnectionStore,
  Workflows,
};

export function installTestHooks() {
  ensureDom();

  beforeEach(() => {
    useConnectionStore.setState({
      baseUrl: 'http://server.test',
      token: '',
      agentToken: '',
      refreshMs: 60_000,
    });
  });

  afterEach(() => {
    for (const unmount of [...mounted]) unmount();
    globalThis.fetch = realFetch;
    useConnectionStore.setState({ baseUrl: '/api', token: '', agentToken: '', refreshMs: 3000 });
  });
}
