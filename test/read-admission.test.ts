import { expect, test } from 'bun:test';
import { ReadAdmission } from '../agent/db/readAdmission';

const deadline = () => performance.now() + 1000;

test('ordinary read bursts wait fairly while custom queries remain strictly capped', async () => {
  const pool = new ReadAdmission();
  const first = pool.acquire(false, deadline()) as () => void;
  const second = pool.acquire(false, deadline()) as () => void;
  const third = pool.acquire(true, deadline());
  const fourth = pool.acquire(true, deadline());
  expect(pool.load).toBe(2);
  expect(pool.pending).toBe(2);
  expect(() => pool.acquire(false, deadline())).toThrow('Too many queries');
  first();
  const releaseThird = await third;
  expect(pool.load).toBe(2);
  expect(pool.pending).toBe(1);
  first(); // Releasing twice cannot admit another reader or undercount the pool.
  expect(pool.pending).toBe(1);
  releaseThird();
  const releaseFourth = await fourth;
  expect(pool.pending).toBe(0);
  releaseFourth();
  second();
  expect(pool.load).toBe(0);
});

test('cancelled waiters leave neither capacity reservations nor listeners behind', async () => {
  const pool = new ReadAdmission();
  const first = pool.acquire(false, deadline()) as () => void;
  const second = pool.acquire(false, deadline()) as () => void;
  const controller = new AbortController();
  const waiting = pool.acquire(true, deadline(), controller.signal);
  controller.abort(new Error('disconnected'));
  await expect(waiting).rejects.toThrow('disconnected');
  expect(pool.pending).toBe(0);
  expect(pool.load).toBe(2);
  expect(() => pool.acquire(true, deadline(), controller.signal)).toThrow('disconnected');
  first();
  second();
  expect(pool.load).toBe(0);
});

test('the pending queue is finite and expired requests never become active', async () => {
  const pool = new ReadAdmission();
  const first = pool.acquire(false, deadline()) as () => void;
  const second = pool.acquire(false, deadline()) as () => void;
  const waiting = Array.from({ length: 32 }, () =>
    Promise.resolve(pool.acquire(true, performance.now() + 40)).catch((error) => error)
  );
  expect(pool.pending).toBe(32);
  expect(() => pool.acquire(true, deadline())).toThrow('Too many queries');
  const failures = await Promise.all(waiting);
  expect(
    failures.every((error) => error instanceof Error && error.message.includes('time limit'))
  ).toBe(true);
  expect(pool.pending).toBe(0);
  expect(pool.load).toBe(2);
  first();
  second();
  expect(pool.load).toBe(0);
});
