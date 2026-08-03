import { describe, expect, it } from 'bun:test';
import { actionGates } from '../src/lib/jobActions';

/**
 * actionGates is the single source of truth for which job actions the server
 * can safely expose in a given state, shared by JobInspector and JobsPro. This
 * locks the full truth table so the two surfaces can never drift. DLQ retry and
 * completed requeue stay closed in every state because v2.8.55 cannot prove
 * reverse-flow safety atomically with either transition.
 */

type Gates = ReturnType<typeof actionGates>;

// The complete expected matrix. Every state → exactly which gates are open.
const MATRIX: Record<string, Gates> = {
  waiting: g({ setPriority: true, setDelay: true }),
  prioritized: g({ setPriority: true, setDelay: true }),
  'waiting-children': g({}),
  delayed: g({ promote: true, setPriority: true, setDelay: true }),
  active: g({}),
  completed: g({}),
  failed: g({}),
  stalled: g({}), // an unknown / terminal-ish state opens nothing
};

// Build a full gate object defaulting every flag to false, then apply overrides.
function g(open: Partial<Gates>): Gates {
  return {
    cancel: false,
    discard: false,
    promote: false,
    retryDlq: false,
    requeueCompleted: false,
    setPriority: false,
    setDelay: false,
    ...open,
  };
}

describe('actionGates', () => {
  for (const [state, expected] of Object.entries(MATRIX)) {
    it(`gates "${state}" correctly`, () => {
      expect(actionGates(state)).toEqual(expected);
    });
  }

  it('opens nothing for an undefined state (never throws)', () => {
    expect(actionGates(undefined)).toEqual(g({}));
  });

  it('treats an unrecognized state as no-actions, not a crash', () => {
    expect(actionGates('totally-made-up')).toEqual(g({}));
  });

  it('only a delayed job can be promoted', () => {
    const promotable = Object.keys(MATRIX).filter((s) => actionGates(s).promote);
    expect(promotable).toEqual(['delayed']);
  });

  it('opens no broker state transition for an active job', () => {
    expect(actionGates('active')).toEqual(g({}));
  });

  it('cannot discard either a stale runnable snapshot or a job that became active', () => {
    expect(actionGates('waiting').discard).toBe(false);
    expect(actionGates('delayed').discard).toBe(false);
    expect(actionGates('prioritized').discard).toBe(false);
    expect(actionGates('active').discard).toBe(false);
  });

  it('never exposes cancel or discard because state and reverse flow safety cannot be proven', () => {
    for (const state of [...Object.keys(MATRIX), undefined]) {
      expect(actionGates(state).cancel).toBe(false);
      expect(actionGates(state).discard).toBe(false);
    }
  });

  it('never exposes DLQ retry or completed requeue for any state', () => {
    for (const state of [...Object.keys(MATRIX), undefined]) {
      expect(actionGates(state).retryDlq).toBe(false);
      expect(actionGates(state).requeueCompleted).toBe(false);
    }
  });
});
