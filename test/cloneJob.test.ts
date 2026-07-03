import { describe, expect, test } from 'bun:test';
import type { JobFull } from '../src/lib/bqTypes';
import { buildCloneState } from '../src/lib/cloneJob';

describe('buildCloneState', () => {
  test('carries queue, pretty-printed data, and present options', () => {
    const job: JobFull = {
      id: 'j1',
      queue: 'emails',
      data: { to: 'a@example.com' },
      priority: 5,
      maxAttempts: 3,
      backoff: 1000,
      timeout: 30000,
      removeOnComplete: true,
      removeOnFail: false,
    };
    const { clone } = buildCloneState(job);
    expect(clone.queue).toBe('emails');
    expect(clone.dataText).toBe(JSON.stringify({ to: 'a@example.com' }, null, 2));
    expect(clone.options).toEqual({
      priority: 5,
      maxAttempts: 3,
      backoff: 1000,
      timeout: 30000,
      removeOnComplete: true,
      removeOnFail: false,
    });
  });

  test('omits absent options and defaults missing queue/data', () => {
    const job: JobFull = { id: 'j2' };
    const { clone } = buildCloneState(job);
    expect(clone.queue).toBe('');
    expect(clone.dataText).toBe(JSON.stringify({}, null, 2));
    expect(clone.options).toEqual({});
  });

  test('does not carry a custom jobId (a clone must get a fresh id)', () => {
    const job = { id: 'j3', queue: 'q', customId: 'idem-1', data: { x: 1 } } as JobFull;
    const state = buildCloneState(job) as unknown as Record<string, unknown>;
    expect(JSON.stringify(state)).not.toContain('idem-1');
  });
});
