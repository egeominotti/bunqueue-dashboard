import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import type { JobFull } from '../src/lib/bqTypes';
import { Diagnostics } from '../src/pages/control/Diagnostics';
import { walkFlow } from '../src/pages/control/Flows';
import {
  JobActionsPanel,
  parseFailureStack,
  parseJobActionNumber,
} from '../src/pages/control/job/JobActionsPanel';
import { previewDelays, remainingRetries } from '../src/pages/control/job/JobBackoff';
import { JobLogs } from '../src/pages/control/job/JobLogs';
import { JobInspector } from '../src/pages/control/JobInspector';
import { selectionLabel, withoutActed } from '../src/pages/control/JobsPro';
import { MetricsPro } from '../src/pages/control/MetricsPro';
import { configSig, useSyncedConfig } from '../src/pages/control/queue/ConfigForms';
import {
  cleanArgs,
  promoteCountArgs,
  rateLimitArgs,
} from '../src/pages/control/queue/QueueActions';
import { duplicateKeys } from '../src/pages/control/server/EnvVarsEditor';
import { discoverAllQueues, Jobs, jobDataName, MAX_ALL_QUEUE_JOB_FANOUT } from '../src/pages/Jobs';
import { ensureDom, renderHook, settle } from './domSetup';

// Regression tests for the "job-queue-pages" audit package: honest reporting of
// failed sub-fetches (Flows), last-to-START-wins sequencing (JobLogs, Diagnostics
// ping), confirm-text/request agreement (Clean), the save-vs-poll baseline race
// (ConfigForms) and two off-by-one/pluralization readouts.

const realFetch = globalThis.fetch;

const realConfirm = window.confirm;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Mount a component into a throwaway root under act(). */
function render(element: React.ReactElement) {
  ensureDom();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(element));
  return { container, unmount: () => act(() => root.unmount()) };
}

function clickText(container: HTMLElement, text: string) {
  const btn = [...container.querySelectorAll('button')].find((b) =>
    (b.textContent ?? '').includes(text)
  );
  if (!btn) throw new Error(`no button matching "${text}"`);
  act(() => {
    btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
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

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

export type { JobFull };
export {
  act,
  afterEach,
  beforeEach,
  cleanArgs,
  clickText,
  configSig,
  createElement,
  createRoot,
  Diagnostics,
  deferred,
  describe,
  discoverAllQueues,
  duplicateKeys,
  ensureDom,
  expect,
  JobActionsPanel,
  JobInspector,
  JobLogs,
  Jobs,
  jobDataName,
  json,
  MAX_ALL_QUEUE_JOB_FANOUT,
  MemoryRouter,
  MetricsPro,
  parseFailureStack,
  parseJobActionNumber,
  previewDelays,
  promoteCountArgs,
  rateLimitArgs,
  realConfirm,
  realFetch,
  remainingRetries,
  render,
  renderHook,
  selectionLabel,
  settle,
  setValue,
  test,
  useConnectionStore,
  useSyncedConfig,
  walkFlow,
  withoutActed,
};

export function installTestHooks() {
  beforeEach(() => {
    ensureDom();
    useConnectionStore.setState({ baseUrl: 'http://srv', token: '', agentToken: '' });
    window.confirm = () => true;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    window.confirm = realConfirm;
    useConnectionStore.setState({ baseUrl: '/api', token: '', agentToken: '' });
  });
}
