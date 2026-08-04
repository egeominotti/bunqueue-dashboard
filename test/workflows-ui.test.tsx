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

ensureDom();

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

describe('Workflow Engine dashboard behavior', () => {
  test('selection reconciliation replaces vanished rows but preserves explicit links', () => {
    const pageSelection: WorkflowSelection = { id: 'gone', source: 'page' };
    expect(reconcileWorkflowSelection(pageSelection, [summary('next')])).toEqual({
      id: 'next',
      source: 'page',
    });
    const linked: WorkflowSelection = { id: 'child-outside-page', source: 'link' };
    expect(reconcileWorkflowSelection(linked, [summary('next')])).toBe(linked);
    expect(reconcileWorkflowSelection(pageSelection, [])).toBeNull();
  });

  test('pagination clears the old detail and selects from the new page', async () => {
    const details: string[] = [];
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/workflows/stats') return Response.json(stats);
      if (url.pathname === '/workflows') {
        const second = url.searchParams.get('offset') === '25';
        return Response.json({
          available: true,
          executions: [summary(second ? 'page-b' : 'page-a')],
          total: 26,
          limit: 25,
          offset: second ? 25 : 0,
        });
      }
      const id = decodeURIComponent(url.pathname.slice('/workflows/'.length));
      details.push(id);
      return Response.json(detail(id));
    }) as typeof fetch;

    const { host } = render(
      createElement(MemoryRouter, { initialEntries: ['/workflows'] }, createElement(Workflows))
    );
    await settle(20);
    expect(host.textContent).toContain('page-a');
    click(host, 'Next');
    await settle(20);
    expect(host.textContent).toContain('page-b');
    expect(details.at(-1)).toBe('page-b');
  });

  test('a refresh that removes the selected row retargets its detail safely', async () => {
    let rows = [summary('row-a'), summary('row-b')];
    const details: string[] = [];
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/workflows/stats') return Response.json(stats);
      if (url.pathname === '/workflows') {
        return Response.json({
          available: true,
          executions: rows,
          total: rows.length,
          limit: 25,
          offset: 0,
        });
      }
      const id = decodeURIComponent(url.pathname.slice('/workflows/'.length));
      details.push(id);
      return Response.json(detail(id));
    }) as typeof fetch;

    const { host } = render(
      createElement(MemoryRouter, { initialEntries: ['/workflows'] }, createElement(Workflows))
    );
    await settle(20);
    click(host, 'row-b');
    await settle(10);
    expect(details.at(-1)).toBe('row-b');
    rows = [summary('row-a')];
    click(host, 'Refresh');
    await settle(20);
    expect(details.at(-1)).toBe('row-a');
    expect(host.textContent).not.toContain('row-b');
  });

  test('retains the last good snapshot and exposes retry when refresh fails', async () => {
    let fail = false;
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      if (fail && url.pathname === '/workflows') {
        return Response.json({ error: 'database busy' }, { status: 503 });
      }
      if (url.pathname === '/workflows/stats') return Response.json(stats);
      if (url.pathname === '/workflows') {
        return Response.json({
          available: true,
          executions: [summary('stable-row')],
          total: 1,
          limit: 25,
          offset: 0,
        });
      }
      return Response.json(detail('stable-row'));
    }) as typeof fetch;

    const { host } = render(
      createElement(MemoryRouter, { initialEntries: ['/workflows'] }, createElement(Workflows))
    );
    await settle(20);
    fail = true;
    click(host, 'Refresh');
    await settle(20);
    expect(host.textContent).toContain('showing the last snapshot');
    expect(host.textContent).toContain('stable-row');
    expect(host.textContent).toContain('Retry');
  });

  test('archive scope and state filters produce the exact agent query', async () => {
    const queries: URL[] = [];
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/workflows/stats') return Response.json(stats);
      if (url.pathname === '/workflows') {
        queries.push(url);
        return Response.json({
          available: true,
          executions: [summary('refund-archive', 'completed')],
          total: 1,
          limit: 25,
          offset: 0,
        });
      }
      return Response.json(detail('refund-archive'));
    }) as typeof fetch;

    const { host } = render(
      createElement(
        MemoryRouter,
        { initialEntries: ['/workflows/archive'] },
        createElement(Workflows)
      )
    );
    await settle(20);
    expect(queries.at(-1)?.searchParams.get('kind')).toBe('archive');
    const stateSelect = [...host.querySelectorAll('select')].at(-1);
    if (!stateSelect) throw new Error('Missing workflow state filter');
    setSelect(stateSelect, 'failed');
    await settle(20);
    expect(queries.at(-1)?.searchParams.get('kind')).toBe('archive');
    expect(queries.at(-1)?.searchParams.get('state')).toBe('failed');
  });

  test('shows a recoverable error when execution detail is no longer available', async () => {
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/workflows/stats') return Response.json(stats);
      if (url.pathname === '/workflows') {
        return Response.json({
          available: true,
          executions: [summary('deleted-detail')],
          total: 1,
          limit: 25,
          offset: 0,
        });
      }
      return Response.json({ error: 'Workflow execution not found' }, { status: 404 });
    }) as typeof fetch;

    const { host } = render(
      createElement(MemoryRouter, { initialEntries: ['/workflows'] }, createElement(Workflows))
    );
    await settle(20);
    expect(host.textContent).toContain('Workflow execution not found');
    expect(host.textContent).toContain('Retry');
  });

  test('surfaces a malformed persisted step as an agent error instead of rendering it', async () => {
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/workflows/stats') return Response.json(stats);
      if (url.pathname === '/workflows') {
        return Response.json({
          available: true,
          executions: [summary('malformed-step')],
          total: 1,
          limit: 25,
          offset: 0,
        });
      }
      return Response.json(
        { error: 'Workflow store contains an invalid step record' },
        { status: 400 }
      );
    }) as typeof fetch;

    const { host } = render(
      createElement(MemoryRouter, { initialEntries: ['/workflows'] }, createElement(Workflows))
    );
    await settle(20);
    expect(host.textContent).toContain('Workflow store contains an invalid step record');
    expect(host.textContent).toContain('Retry');
    expect(host.textContent).not.toContain('Step timeline');
  });
});
