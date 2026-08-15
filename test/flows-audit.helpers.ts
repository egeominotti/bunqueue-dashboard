import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import type { JobFull } from '../src/lib/bqTypes';
import {
  Flows,
  findDirectedCycle,
  flowJobIdError,
  flowStateStyle,
  recentFlowsStorageKey,
  resolveFlowRoot,
  walkFlow,
} from '../src/pages/control/Flows';
import { ensureDom, settle } from './domSetup';

const realFetch = globalThis.fetch;

const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const snapshot = (id: string, overrides: Partial<JobFull> = {}): JobFull => ({
  id,
  queue: 'flow-q',
  state: 'waiting',
  parentId: null,
  childrenIds: [],
  dependsOn: [],
  ...overrides,
});

function mockJobs(
  jobs: Record<string, JobFull | Response | undefined>,
  calls: string[] = []
): void {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    // Bunqueue v2.8.55 deliberately treats /jobs/:id as an opaque segment.
    const id = path.slice(path.lastIndexOf('/') + 1);
    calls.push(id);
    const value = jobs[id];
    if (value instanceof Response) return Promise.resolve(value.clone());
    if (!value) return Promise.resolve(response({ ok: false, error: 'Job not found' }, 404));
    return Promise.resolve(response({ ok: true, job: value }));
  }) as typeof fetch;
}

export type { JobFull };
export {
  act,
  afterEach,
  beforeEach,
  createElement,
  createRoot,
  describe,
  ensureDom,
  expect,
  Flows,
  findDirectedCycle,
  flowJobIdError,
  flowStateStyle,
  MemoryRouter,
  mockJobs,
  realFetch,
  recentFlowsStorageKey,
  resolveFlowRoot,
  response,
  settle,
  snapshot,
  test,
  useConnectionStore,
  useNavigate,
  walkFlow,
};

export function installTestHooks() {
  beforeEach(() => {
    ensureDom();
    useConnectionStore.setState({ baseUrl: 'http://flows.test', token: '', agentToken: '' });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    useConnectionStore.setState({ baseUrl: '/api', token: '', agentToken: '' });
    localStorage.removeItem(recentFlowsStorageKey('http://flows.test'));
    localStorage.removeItem(recentFlowsStorageKey('http://tenant-a.test'));
    localStorage.removeItem(recentFlowsStorageKey('http://tenant-b.test'));
  });
}
