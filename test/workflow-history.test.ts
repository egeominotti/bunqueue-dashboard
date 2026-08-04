import { describe, expect, test } from 'bun:test';
import { buildExecutionHistory } from '../src/features/workflows/domain/executionHistory';
import type { WorkflowExecutionDetail } from '../src/lib/bqTypes';

const execution: WorkflowExecutionDetail = {
  id: 'run-1',
  workflowName: 'checkout',
  state: 'compensation-stuck',
  currentNodeIndex: 2,
  createdAt: 100,
  updatedAt: 900,
  input: {},
  signals: { approval: { by: 'ops' } },
  steps: {
    reserve: {
      status: 'completed',
      startedAt: 200,
      completedAt: 300,
      attempts: 1,
      compensation: { status: 'compensated', at: 700 },
    },
    charge: {
      status: 'failed',
      startedAt: 400,
      completedAt: 500,
      error: 'declined',
      compensation: { status: 'compensation-failed', at: 800, error: 'offline' },
    },
  },
};

describe('Temporal-style persisted execution history', () => {
  test('orders execution, step, compensation and terminal transitions chronologically', () => {
    const history = buildExecutionHistory(execution);
    expect(history.map((item) => item.id)).toEqual([
      'execution-started',
      'step:reserve:started',
      'step:reserve:settled',
      'step:charge:started',
      'step:charge:settled',
      'step:reserve:compensation',
      'step:charge:compensation',
      'execution-settled',
      'signal:approval',
    ]);
  });

  test('does not invent a timestamp for persisted signals', () => {
    const signal = buildExecutionHistory(execution).find((item) => item.category === 'signal');
    expect(signal?.title).toBe('Signal persisted: approval');
    expect(signal).not.toHaveProperty('at');
  });
});
