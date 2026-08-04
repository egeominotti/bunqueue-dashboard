import { describe, expect, test } from 'bun:test';
import { AgentLifecycleGate } from '../agent/server/lifecycle';

describe('AgentLifecycleGate', () => {
  test('runs leases concurrently without letting later leases barge past a writer', async () => {
    const gate = new AgentLifecycleGate();
    const first = deferred();
    const second = deferred();
    const events: string[] = [];
    const leaseOne = gate.lease(async () => {
      events.push('lease-1:start');
      await first.ready;
      events.push('lease-1:end');
    });
    const leaseTwo = gate.lease(async () => {
      events.push('lease-2:start');
      await second.ready;
      events.push('lease-2:end');
    });
    await Bun.sleep(0);
    const writer = gate.run(async () => {
      events.push('writer');
    });
    const laterLease = gate.lease(async () => {
      events.push('lease-3');
    });

    expect(events).toEqual(['lease-1:start', 'lease-2:start']);
    first.release();
    await Bun.sleep(0);
    expect(events).not.toContain('writer');
    second.release();
    await Promise.all([leaseOne, leaseTwo, writer, laterLease]);

    expect(events).toEqual([
      'lease-1:start',
      'lease-2:start',
      'lease-1:end',
      'lease-2:end',
      'writer',
      'lease-3',
    ]);
  });

  test('recovers after failures and closes once after active leases settle', async () => {
    const gate = new AgentLifecycleGate();
    await expect(gate.lease(async () => Promise.reject(new Error('lease failed')))).rejects.toThrow(
      'lease failed'
    );
    await expect(gate.run(async () => Promise.reject(new Error('writer failed')))).rejects.toThrow(
      'writer failed'
    );
    const active = deferred();
    const lease = gate.lease(async () => active.ready);
    await Bun.sleep(0);
    let closes = 0;
    const closing = gate.close(async () => {
      closes++;
    });
    const sameClosing = gate.close(async () => {
      closes += 100;
    });

    await Bun.sleep(0);
    expect(closes).toBe(0);
    await expect(gate.lease(async () => undefined)).rejects.toThrow('agent is closing');
    await expect(gate.run(async () => undefined)).rejects.toThrow('agent is closing');
    active.release();
    await Promise.all([lease, closing, sameClosing]);
    expect(closes).toBe(1);
  });
});

function deferred() {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { ready, release };
}
