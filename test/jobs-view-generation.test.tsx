import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, MemoryRouter } from 'react-router-dom';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import type { QueueSummaryFull } from '../src/lib/bqTypes';
import { useJobsView } from '../src/pages/control/jobsPro/useJobsView';
import { ensureDom, settle } from './domSetup';

ensureDom();
let current: ReturnType<typeof useJobsView>;
let unmount: (() => void) | undefined;
const frames: Array<{ queue: string; page: number; selected: string[]; view: string }> = [];
const summary = [{ name: 'orders' }, { name: 'emails' }] as QueueSummaryFull[];
let originalConnection: ReturnType<typeof useConnectionStore.getState>;

function Probe() {
  current = useJobsView(summary);
  frames.push({
    queue: current.queue,
    page: current.page,
    selected: [...current.selected],
    view: current.view,
  });
  return null;
}

beforeEach(() => {
  originalConnection = useConnectionStore.getState();
  useConnectionStore.setState({ baseUrl: 'http://server-a.test', token: '', agentToken: '' });
  frames.length = 0;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  unmount = () => {
    act(() => root.unmount());
    host.remove();
  };
  act(() =>
    root.render(
      createElement(
        MemoryRouter,
        {
          initialEntries: ['/jobs?queue=orders&status=delayed'],
        },
        createElement(Probe)
      )
    )
  );
});
afterEach(() => {
  unmount?.();
  useConnectionStore.setState(originalConnection);
});

function select() {
  act(() => current.setSelected(new Set(['shared-id'])));
}
function expectFreshFrames() {
  expect(frames.length).toBeGreaterThan(0);
  expect(frames.every((frame) => frame.selected.length === 0)).toBe(true);
  expect(current.selected.size).toBe(0);
}

describe('Jobs view generations', () => {
  test('returning to a queue discards its old page and selection on every frame', async () => {
    act(() => current.setPage(2));
    select();
    const originalView = current.view;
    frames.length = 0;
    act(() => current.selectQueue('emails'));
    await settle(2);
    expectFreshFrames();
    expect(current.page).toBe(0);
    frames.length = 0;
    act(() => current.selectQueue('orders'));
    await settle(2);
    expectFreshFrames();
    expect(current.page).toBe(0);
    expect(current.view).not.toBe(originalView);
  });

  test('moving away and back to a page never restores its old selected IDs', () => {
    select();
    const originalView = current.view;
    frames.length = 0;
    act(() => current.setPage(1));
    expectFreshFrames();
    frames.length = 0;
    act(() => current.setPage(0));
    expectFreshFrames();
    expect(current.view).not.toBe(originalView);
  });

  test('returning to a status and invoking an old page selection callback cannot restore IDs', async () => {
    select();
    const staleSelect = current.setSelected;
    act(() => current.setPage(1));
    act(() => current.setPage(0));
    act(() => staleSelect(new Set(['shared-id'])));
    expect(current.selected.size).toBe(0);
    select();
    frames.length = 0;
    act(() => current.selectStatus('active'));
    await settle(2);
    expectFreshFrames();
    frames.length = 0;
    act(() => current.selectStatus('delayed'));
    await settle(2);
    expectFreshFrames();
  });

  test('server A to B to A resets page and IDs even when queue and status match', async () => {
    act(() => current.setPage(2));
    select();
    const originalView = current.view;
    frames.length = 0;
    act(() => useConnectionStore.setState({ baseUrl: 'http://server-b.test' }));
    await settle(2);
    expectFreshFrames();
    expect(current.page).toBe(0);
    select();
    frames.length = 0;
    act(() => useConnectionStore.setState({ baseUrl: 'http://server-a.test' }));
    await settle(2);
    expectFreshFrames();
    expect(current.page).toBe(0);
    expect(current.view).not.toBe(originalView);
  });

  test('batched server A to B to A and stale callbacks cannot revive selection', async () => {
    select();
    const staleSelect = current.setSelected;
    const stalePage = current.setPage;
    const originalView = current.view;
    frames.length = 0;
    act(() => {
      useConnectionStore.setState({ baseUrl: 'http://server-b.test' });
      useConnectionStore.setState({ baseUrl: 'http://server-a.test' });
    });
    await settle(2);
    expectFreshFrames();
    expect(current.view).not.toBe(originalView);
    frames.length = 0;
    act(() => {
      staleSelect(new Set(['shared-id']));
      stalePage(7);
    });
    expect(current.selected.size).toBe(0);
    expect(current.page).toBe(0);
  });
});

test('a queue selected when discovery appears wins over pending default canonicalization', async () => {
  unmount?.();
  const host = document.createElement('div');
  const root = createRoot(host);
  let chooseOnDiscovery = true;
  function DiscoveryChoice({ discovered }: { discovered: boolean }) {
    current = useJobsView(discovered ? summary : null);
    useLayoutEffect(() => {
      if (!discovered || !chooseOnDiscovery) return;
      chooseOnDiscovery = false;
      current.selectQueue('emails');
    }, [discovered]);
    return null;
  }
  unmount = () => act(() => root.unmount());
  const renderDiscovery = (discovered: boolean) =>
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: ['/jobs'] },
        createElement(DiscoveryChoice, { discovered })
      )
    );
  act(() => renderDiscovery(false));
  act(() => renderDiscovery(true));
  await settle(2);
  expect(current.queue).toBe('emails');
});

test('discovered queue options become interactive only after their URL is canonical', () => {
  unmount?.();
  const originalUrl = window.location.href;
  window.location.href = 'http://localhost/jobs';
  const root = createRoot(document.createElement('div'));
  const committedQueries: string[] = [];
  function Discovery({ discovered }: { discovered: boolean }) {
    current = useJobsView(discovered ? summary : null);
    useLayoutEffect(() => {
      if (discovered) committedQueries.push(window.location.search);
    }, [discovered]);
    return null;
  }
  unmount = () => {
    act(() => root.unmount());
    window.location.href = originalUrl;
  };
  const show = (discovered: boolean) =>
    root.render(createElement(BrowserRouter, {}, createElement(Discovery, { discovered })));
  act(() => show(false));
  act(() => show(true));
  expect(committedQueries).toEqual(['?queue=orders']);
});
