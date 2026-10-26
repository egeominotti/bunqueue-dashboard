import { afterEach, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { FailureDiagnostics } from '../src/features/discovery/FailureDiagnostics';
import { GlobalSearch } from '../src/features/discovery/GlobalSearch';
import { useDiscovery } from '../src/features/discovery/useDiscovery';
import { renderHook, settle } from './domSetup';

const originalFetch = globalThis.fetch;
const originalState = useConnectionStore.getState();
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  globalThis.fetch = originalFetch;
  useConnectionStore.setState(originalState);
});
const page = {
  ok: true,
  queues: [{ name: 'orders', waiting: 0, delayed: 0, active: 0, dlq: 0, paused: false }],
  total: 1,
  limit: 100,
  offset: 0,
  timestamp: 1,
};

test('a new query suppresses late results even when fetch ignores cancellation', async () => {
  let release!: (response: Response) => void;
  let jobs = 0;
  globalThis.fetch = (async (input) => {
    if (String(input).includes('/dashboard/queues')) return Response.json(page);
    jobs++;
    if (jobs === 1)
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    return Response.json({ ok: true, jobs: [{ id: 'fresh', name: 'new' }] });
  }) as typeof fetch;
  const hook = renderHook(({ text }) => useDiscovery({ text }), { text: 'old' });
  cleanups.push(hook.unmount);
  await settle(2);
  hook.rerender({ text: 'new' });
  await settle(2);
  expect(hook.result.current.report?.rows[0].job.id).toBe('fresh');
  release(Response.json({ ok: true, jobs: [{ id: 'stale', name: 'old' }] }));
  await settle(2);
  expect(hook.result.current.report?.rows[0].job.id).toBe('fresh');
});

test('connection edits clear previous source results and abort in-flight work', async () => {
  let heldSignal: AbortSignal | null | undefined;
  globalThis.fetch = (async (input, init) => {
    if (String(input).includes('/dashboard/queues')) return Response.json(page);
    heldSignal = init?.signal;
    return new Promise<Response>(() => {});
  }) as typeof fetch;
  const hook = renderHook(() => useDiscovery({}));
  cleanups.push(hook.unmount);
  await settle(2);
  const priorSignal = heldSignal;
  act(() => useConnectionStore.getState().setToken('new-token'));
  await settle(2);
  expect(priorSignal?.aborted).toBe(true);
  expect(hook.result.current.report).toBeNull();
});

test('search and failures render coverage and original job inspection actions', async () => {
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.includes('/dashboard/queues')) return Response.json(page);
    if (url.includes('/dlq?')) return Response.json({ ok: true, entries: [], total: 0 });
    return Response.json({
      ok: true,
      jobs: [{ id: 'job-1', state: 'failed', failedReason: 'HTTP 404' }],
    });
  }) as typeof fetch;
  for (const Component of [GlobalSearch, FailureDiagnostics]) {
    const host = document.createElement('div');
    const root = createRoot(host);
    cleanups.push(() => act(() => root.unmount()));
    act(() => root.render(createElement(MemoryRouter, null, createElement(Component))));
    await settle(2);
    expect(host.textContent).toContain('live');
    expect(host.textContent).toContain('job-1');
    expect(host.querySelector('button[aria-label="Inspect job job-1"]')).not.toBeNull();
  }
});
