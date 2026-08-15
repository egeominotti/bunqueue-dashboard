import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { useToastStore } from '../src/components/dashboard/stores/toastStore';
import { DlqControl } from '../src/pages/control/DlqControl';
import { DlqPro } from '../src/pages/control/DlqPro';
import { JobsPro } from '../src/pages/control/JobsPro';
import { QueuesOverview } from '../src/pages/control/QueuesOverview';
import { Webhooks } from '../src/pages/control/Webhooks';
import { WorkersPro } from '../src/pages/control/WorkersPro';
import { ensureDom, settle } from './domSetup';

const realFetch = globalThis.fetch;

const realConfirm = window.confirm;

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'content-type': 'application/json' } });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function render(element: ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(element));
  return {
    host,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

function buttonByText(host: HTMLElement, text: string): HTMLButtonElement {
  const button = [...host.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === text
  );
  if (!button) throw new Error(`No button with text "${text}"`);
  return button;
}

function clickSameTick(button: HTMLButtonElement, count = 2): void {
  act(() => {
    for (let index = 0; index < count; index++) {
      button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    }
  });
}

function setInput(input: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(
      input,
      value
    );
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}

const queueSummary = (name: string, paused = false) => ({
  name,
  paused,
  counts: { waiting: 1, prioritized: 0, active: 0, completed: 0, failed: 0, delayed: 0 },
});

const dashboardQueue = (name: string, dlq = 0) => ({
  name,
  waiting: 0,
  delayed: 0,
  active: 0,
  dlq,
  paused: false,
});

export type { ReactElement };
export {
  act,
  afterEach,
  beforeEach,
  buttonByText,
  clickSameTick,
  createElement,
  createRoot,
  DlqControl,
  DlqPro,
  dashboardQueue,
  deferred,
  describe,
  ensureDom,
  expect,
  JobsPro,
  json,
  MemoryRouter,
  QueuesOverview,
  queueSummary,
  realConfirm,
  realFetch,
  render,
  setInput,
  settle,
  test,
  useConnectionStore,
  useToastStore,
  Webhooks,
  WorkersPro,
};

export function installTestHooks() {
  beforeEach(() => {
    ensureDom();
    useConnectionStore.setState({
      baseUrl: 'http://server-a.test',
      token: '',
      agentToken: '',
      refreshMs: 60_000,
    });
    useToastStore.setState({ toasts: [] });
    window.confirm = () => true;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    window.confirm = realConfirm;
    useConnectionStore.setState({
      baseUrl: '/api',
      token: '',
      agentToken: '',
      refreshMs: 3000,
    });
    useToastStore.setState({ toasts: [] });
  });
}
