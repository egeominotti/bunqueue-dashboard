import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { act, createElement, type ReactElement, StrictMode } from 'react';

import { createRoot } from 'react-dom/client';

import { MemoryRouter } from 'react-router-dom';

import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';

import { bq } from '../src/lib/bq';

import {
  actionResultCount,
  loadAllQueuePages,
  QueueControl,
  resolveQueueSelection,
} from '../src/pages/control/QueueControl';

import {
  DlqConfigForm,
  dlqConfigMutationPayload,
  StallForm,
  stallConfigPayload,
} from '../src/pages/control/queue/ConfigForms';

import {
  concurrencyArgs,
  LifecycleCard,
  promoteConfirmation,
  type RunAction,
  rateLimitArgs,
} from '../src/pages/control/queue/QueueActions';

import { ensureDom, settle } from './domSetup';

const realFetch = globalThis.fetch;

const mounted = new Set<() => void>();

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'content-type': 'application/json' } });

const stallConfig = {
  enabled: true,
  stallInterval: 30_000,
  maxStalls: 3,
  gracePeriod: 5_000,
};

const dlqConfig = {
  autoRetry: false,
  autoRetryInterval: 3_600_000,
  maxAutoRetries: 3,
  maxAge: 604_800_000,
  maxEntries: 10_000,
};

function queueEntry(name: string) {
  return { name, waiting: 0, delayed: 0, active: 0, dlq: 0, paused: false };
}

function queuePage(names: string[], offset = 0, total = names.length) {
  return {
    ok: true,
    queues: names.map(queueEntry),
    total,
    limit: 500,
    offset,
    timestamp: 1,
  };
}

function queueDetail(name: string, waiting = 1) {
  return {
    ok: true,
    name,
    counts: {
      waiting,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
      prioritized: 0,
      'waiting-children': 0,
      paused: 0,
    },
    paused: false,
    priorityCounts: {},
    dlqPreview: [],
    timestamp: 1,
  };
}

function queueSummaryEntry(name: string) {
  return {
    name,
    paused: false,
    counts: { waiting: 1, prioritized: 0, active: 0, completed: 0, failed: 0, delayed: 0 },
  };
}

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

function renderControl() {
  return render(createElement(MemoryRouter, null, createElement(QueueControl)));
}

function findButton(host: HTMLElement, text: string, index = 0): HTMLButtonElement {
  const buttons = [...host.querySelectorAll('button')].filter((button) =>
    (button.textContent ?? '').includes(text)
  );
  const button = buttons[index];
  if (!button) throw new Error(`No button matching "${text}" at index ${index}`);
  return button;
}

function click(host: HTMLElement, text: string, index = 0) {
  const button = findButton(host, text, index);
  act(() => button.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
}

function setValue(element: HTMLInputElement | HTMLSelectElement, value: string) {
  act(() => {
    const prototype =
      element instanceof window.HTMLSelectElement
        ? window.HTMLSelectElement.prototype
        : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
    element.dispatchEvent(new window.Event('input', { bubbles: true }));
    element.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}

export type { ReactElement, RunAction };
export {
  act,
  actionResultCount,
  afterEach,
  beforeEach,
  bq,
  click,
  concurrencyArgs,
  createElement,
  createRoot,
  DlqConfigForm,
  deferred,
  describe,
  dlqConfig,
  dlqConfigMutationPayload,
  ensureDom,
  expect,
  findButton,
  json,
  LifecycleCard,
  loadAllQueuePages,
  MemoryRouter,
  mounted,
  promoteConfirmation,
  QueueControl,
  queueDetail,
  queueEntry,
  queuePage,
  queueSummaryEntry,
  rateLimitArgs,
  realFetch,
  render,
  renderControl,
  resolveQueueSelection,
  StallForm,
  StrictMode,
  settle,
  setValue,
  stallConfig,
  stallConfigPayload,
  test,
  useConnectionStore,
};

export function installTestHooks() {
  beforeEach(() => {
    ensureDom();
    useConnectionStore.setState({
      baseUrl: 'http://server.test',
      token: '',
      agentToken: '',
      refreshMs: 3_000,
    });
  });

  afterEach(() => {
    for (const unmount of [...mounted]) unmount();
    globalThis.fetch = realFetch;
    useConnectionStore.setState({
      baseUrl: '/api',
      token: '',
      agentToken: '',
      refreshMs: 3_000,
    });
  });
}
