import { describe, expect, test } from 'bun:test';
import { safeErrorMessage } from '../agent/errorMessage';
import { errorMessage, errorStatus } from '../agent/server/errors';

describe('safe error messages', () => {
  test('normalizes empty messages and preserves ordinary failures', () => {
    expect(safeErrorMessage(new Error('ordinary failure'))).toBe('ordinary failure');
    expect(safeErrorMessage(new Error(''))).toBe('Unknown error');
  });

  test('never throws for non-coercible values', () => {
    const hostile = {
      [Symbol.toPrimitive]() {
        throw new Error('coercion exploded');
      },
    };

    expect(safeErrorMessage(hostile)).toBe('Unprintable error');
    expect(errorMessage(hostile)).toBe('Unprintable error');
    expect(errorStatus(hostile)).toBe(400);
  });

  test('never throws when instanceof itself is trapped', () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('prototype exploded');
        },
      }
    );

    expect(safeErrorMessage(hostile)).toBe('Unprintable error');
    expect(errorMessage(hostile)).toBe('Unprintable error');
    expect(errorStatus(hostile)).toBe(500);
  });
});
