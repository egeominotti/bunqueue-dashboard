import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { act, createElement, type ReactElement } from 'react';

import { createRoot } from 'react-dom/client';

import { MemoryRouter } from 'react-router-dom';

import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';

import {
  AddJob,
  addJobCloneDefaults,
  MAX_JOB_DATA_CHARS,
  parseAddJobNumbers,
} from '../src/pages/control/AddJob';

import {
  assertCronNameAvailable,
  buildCronBody,
  type CronFormValues,
  CronManager,
  existingCronNameError,
} from '../src/pages/control/CronManager';

import { ensureDom, settle } from './domSetup';

const realFetch = globalThis.fetch;

const realConfirm = window.confirm;

const mountedViews = new Set<() => void>();

const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'content-type': 'application/json' } });

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
  let mounted = true;
  const unmount = () => {
    if (!mounted) return;
    mounted = false;
    mountedViews.delete(unmount);
    act(() => root.unmount());
    host.remove();
  };
  mountedViews.add(unmount);
  return {
    host,
    unmount,
  };
}

function setInput(input: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(
      input,
      value
    );
    const propsKey = Object.getOwnPropertyNames(input).find((key) =>
      key.startsWith('__reactProps$')
    );
    const props = propsKey
      ? ((input as unknown as Record<string, unknown>)[propsKey] as {
          onChange?: (event: { target: HTMLInputElement; currentTarget: HTMLInputElement }) => void;
        })
      : null;
    if (!props?.onChange) throw new Error('Controlled input has no React onChange handler');
    props.onChange({ target: input, currentTarget: input });
  });
}

const cronValues = (schedule: string): CronFormValues => ({
  name: 'hourly-report',
  queue: 'reports',
  mode: 'cron',
  schedule,
  every: '',
  dataText: '{}',
  timezone: '',
  priority: '',
  preventOverlap: true,
  skipIfNoWorker: false,
  maxLimit: '',
  immediately: false,
  skipMissedOnRestart: true,
  uniqueKey: '',
  dedupTtl: '',
  dedupExtend: false,
  dedupReplace: false,
  jobMaxAttempts: '',
  jobBackoff: '',
  jobTimeout: '',
  jobDelay: '',
  jobStallTimeout: '',
  jobRemoveOnComplete: false,
  jobRemoveOnFail: false,
});

export type { CronFormValues, ReactElement };
export {
  AddJob,
  act,
  addJobCloneDefaults,
  afterEach,
  assertCronNameAvailable,
  beforeEach,
  buildCronBody,
  CronManager,
  createElement,
  createRoot,
  cronValues,
  deferred,
  describe,
  ensureDom,
  existingCronNameError,
  expect,
  json,
  MAX_JOB_DATA_CHARS,
  MemoryRouter,
  mountedViews,
  parseAddJobNumbers,
  realConfirm,
  realFetch,
  render,
  setInput,
  settle,
  test,
  useConnectionStore,
};

export function installTestHooks() {
  beforeEach(() => {
    ensureDom();
    useConnectionStore.setState({
      baseUrl: 'http://cron-clone.test',
      token: '',
      agentToken: '',
      refreshMs: 60_000,
    });
    window.confirm = () => true;
  });

  afterEach(() => {
    for (const unmount of [...mountedViews]) unmount();
    globalThis.fetch = realFetch;
    window.confirm = realConfirm;
    useConnectionStore.setState({
      baseUrl: '/api',
      token: '',
      agentToken: '',
      refreshMs: 3000,
    });
    document.body.replaceChildren();
  });
}
