import { describe, expect, test } from 'bun:test';
import { createPollGate } from '../src/lib/usePolledData';

// Regression: a page opened in a background tab used to sit on "Loading…"
// forever, because the poll loop skipped even the FIRST fetch while
// document.hidden. The gate encodes the fixed rule: first tick always
// fetches, later ticks only while visible.
describe('createPollGate', () => {
  test('first tick fetches even while hidden (the background-tab fix)', () => {
    const gate = createPollGate(() => true);
    expect(gate()).toBe(true);
  });

  test('later ticks skip while hidden', () => {
    const gate = createPollGate(() => true);
    gate();
    expect(gate()).toBe(false);
    expect(gate()).toBe(false);
  });

  test('later ticks fetch while visible', () => {
    let hidden = true;
    const gate = createPollGate(() => hidden);
    gate();
    expect(gate()).toBe(false);
    hidden = false;
    expect(gate()).toBe(true);
    expect(gate()).toBe(true);
  });

  test('the first tick is consumed by asking the gate, not by visibility', () => {
    // Callers must run other skip-guards (e.g. in-flight) BEFORE the gate:
    // once asked, the always-run first tick is spent.
    const gate = createPollGate(() => true);
    expect(gate()).toBe(true);
    expect(gate()).toBe(false);
  });
});
