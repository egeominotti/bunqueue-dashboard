import { describe, expect, test } from 'bun:test';
import { titleFor } from '../src/components/layout/pageTitle';
import { NAV } from '../src/components/layout/Sidebar';
import { WORKFLOW_SECTIONS, workflowSectionFor } from '../src/pages/control/Workflows';

describe('dedicated Workflow navigation', () => {
  test('exposes every section as an exact sidebar destination', () => {
    const group = NAV.find((entry) => entry.section === 'Workflow');
    expect(group?.items.map(({ to, label, end }) => ({ to, label, end }))).toEqual([
      { to: '/workflows', label: 'Overview', end: true },
      { to: '/flows', label: 'Job Flows', end: true },
      { to: '/workflows/executions', label: 'Executions', end: true },
      { to: '/workflows/waiting', label: 'Waiting & Signals', end: true },
      { to: '/workflows/compensation', label: 'Compensation', end: true },
      { to: '/workflows/archive', label: 'Archive', end: true },
    ]);
  });

  test('pins each operational section to the correct persisted scope', () => {
    expect(workflowSectionFor('/workflows')).toMatchObject({ kind: 'active', state: '' });
    expect(workflowSectionFor('/workflows/executions')).toMatchObject({
      kind: 'active',
      state: '',
      lockKind: true,
    });
    expect(workflowSectionFor('/workflows/waiting')).toMatchObject({
      kind: 'active',
      state: 'waiting',
      lockKind: true,
      lockState: true,
    });
    expect(workflowSectionFor('/workflows/compensation')).toMatchObject({
      kind: 'active',
      state: 'compensation',
      lockKind: true,
      lockState: true,
    });
    expect(workflowSectionFor('/workflows/archive')).toMatchObject({
      kind: 'archive',
      state: '',
      lockKind: true,
    });
    expect(Object.keys(WORKFLOW_SECTIONS)).toHaveLength(5);
  });

  test('gives every section an unambiguous document title', () => {
    expect(titleFor('/workflows')).toBe('Workflow · Overview');
    expect(titleFor('/workflows/executions')).toBe('Workflow · Executions');
    expect(titleFor('/workflows/waiting')).toBe('Workflow · Waiting & Signals');
    expect(titleFor('/workflows/compensation')).toBe('Workflow · Compensation');
    expect(titleFor('/workflows/archive')).toBe('Workflow · Archive');
  });
});
