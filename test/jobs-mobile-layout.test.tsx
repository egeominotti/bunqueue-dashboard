import { afterEach, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import type { JobFull } from '../src/lib/bqTypes';
import { JobsStats } from '../src/pages/control/jobsPro/JobsStats';
import { JobsTable } from '../src/pages/control/jobsPro/JobsTable';
import { ensureDom } from './domSetup';

ensureDom();
const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

test('mobile statistics can expand every metric and collapse without losing the summary', () => {
  const host = render(
    createElement(JobsStats, {
      total: '123',
      waiting: '11',
      prioritized: '12',
      active: '13',
      flowBlocked: '14',
      completed: '66',
      failed: '7',
      failedCount: 7,
      errorRate: '5.7%',
      errorRateTone: 'red',
    })
  );
  const toggle = host.querySelector<HTMLButtonElement>('button[aria-controls]');
  expect(toggle).not.toBeNull();
  expect(toggle?.getAttribute('aria-expanded')).toBe('false');
  const summary = host.querySelector('[aria-label="Job summary"]');
  expect(summary?.textContent).toContain('123');
  expect(summary?.textContent).toContain('13');
  expect(summary?.textContent).toContain('7');
  act(() => toggle?.click());
  expect(toggle?.getAttribute('aria-expanded')).toBe('true');
  const metrics = document.getElementById(toggle!.getAttribute('aria-controls')!);
  expect(metrics).not.toBeNull();
  for (const metric of [
    'Total',
    'Waiting',
    'Prioritized',
    'Active',
    'Flow-blocked',
    'Completed',
    'Failed',
    'Error Rate',
  ]) {
    expect(metrics?.textContent).toContain(metric);
  }
  expect(metrics?.textContent).toContain('standard priority');
  expect(metrics?.textContent).toContain('5.7%');
  act(() => toggle?.click());
  expect(toggle?.getAttribute('aria-expanded')).toBe('false');
  expect(summary?.textContent).toContain('123');
});

test('row actions retain inspection, gated promotion, selection and busy protection', () => {
  const selected: string[] = [];
  const promoted: string[] = [];
  const jobs = [
    { id: 'delayed/1', name: 'email', state: 'delayed', createdAt: 1, priority: 0 },
    { id: 'waiting/2', name: 'other', state: 'waiting', createdAt: 1, priority: 0 },
  ] as JobFull[];
  const props = {
    queue: 'mail',
    rows: jobs,
    search: '',
    discoveryError: false,
    selected: new Set<string>(),
    allSelected: false,
    bulkBusy: false,
    busyIds: new Set<string>(),
    page: 0,
    hasNext: false,
    onToggleAll: () => {},
    onToggle: (id: string) => selected.push(id),
    onRun: (job: JobFull) => {
      promoted.push(job.id);
    },
    onPage: () => {},
  };
  const host = render(createElement(MemoryRouter, null, createElement(JobsTable, props)));
  expect(host.querySelector('a[aria-label="Inspect job delayed/1"]')?.getAttribute('href')).toBe(
    '/job?id=delayed%2F1'
  );
  expect(host.querySelectorAll('button[aria-label="Promote job"]').length).toBe(1);
  act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Promote job"]')?.click());
  act(() =>
    host.querySelector<HTMLInputElement>('input[aria-label="Select job delayed/1"]')?.click()
  );
  expect(promoted).toEqual(['delayed/1']);
  expect(selected).toEqual(['delayed/1']);
  const busyHost = render(
    createElement(MemoryRouter, null, createElement(JobsTable, { ...props, bulkBusy: true }))
  );
  expect(
    busyHost.querySelector<HTMLButtonElement>('button[aria-label="Promote job"]')?.disabled
  ).toBe(true);
});

function render(element: ReactElement): HTMLDivElement {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(element));
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return host;
}
