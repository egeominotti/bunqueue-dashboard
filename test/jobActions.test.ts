import { describe, expect, it } from 'bun:test';
import { actionGates } from '../src/lib/jobActions';

/**
 * actionGates is the single source of truth for which job actions the server
 * will accept in a given state, shared by JobInspector and JobsPro. This locks
 * the full truth table so the two surfaces can never drift and a regression in
 * the gating (offering an action the server would reject, or hiding a legal
 * one) fails the build.
 */

type Gates = ReturnType<typeof actionGates>;

// The complete expected matrix. Every state → exactly which gates are open.
const MATRIX: Record<string, Gates> = {
  waiting: g({ cancel: true, discard: true, setPriority: true, setDelay: true }),
  prioritized: g({ cancel: true, discard: true, setPriority: true, setDelay: true }),
  'waiting-children': g({ cancel: true, discard: true, setPriority: true, setDelay: true }),
  delayed: g({ cancel: true, discard: true, promote: true, setPriority: true, setDelay: true }),
  active: g({ discard: true, retryActive: true, setDelay: true, fail: true, moveToDelayed: true }),
  completed: g({ requeueCompleted: true }),
  failed: g({ retryDlq: true }),
  stalled: g({}), // an unknown / terminal-ish state opens nothing
};

// Build a full gate object defaulting every flag to false, then apply overrides.
function g(open: Partial<Gates>): Gates {
  return {
    cancel: false,
    discard: false,
    promote: false,
    retryActive: false,
    retryDlq: false,
    requeueCompleted: false,
    setPriority: false,
    setDelay: false,
    fail: false,
    moveToDelayed: false,
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

  it('only an active job can be force-failed or moved-to-delayed', () => {
    const failable = Object.keys(MATRIX).filter((s) => actionGates(s).fail);
    const delayable = Object.keys(MATRIX).filter((s) => actionGates(s).moveToDelayed);
    expect(failable).toEqual(['active']);
    expect(delayable).toEqual(['active']);
  });

  it('a completed job is only requeueable; a failed/DLQ job is only DLQ-retryable', () => {
    expect(actionGates('completed').requeueCompleted).toBe(true);
    expect(actionGates('completed').retryDlq).toBe(false);
    expect(actionGates('failed').retryDlq).toBe(true);
    expect(actionGates('failed').requeueCompleted).toBe(false);
  });
});
