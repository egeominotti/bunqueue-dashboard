import { describe, expect, test } from 'bun:test';
import { assertRequiredBunVersion, REQUIRED_BUN_VERSION } from '../scripts/bunVersion';

describe('Bun runtime pin', () => {
  test('accepts the exact repository runtime', () => {
    expect(REQUIRED_BUN_VERSION).toBe('1.4.0');
    expect(Bun.version).toBe(REQUIRED_BUN_VERSION);
    expect(() => assertRequiredBunVersion()).not.toThrow();
  });

  test.each(['1.3.10', '1.4.1', '1.5.0', '2.0.0'])('rejects unpinned Bun %s', (version) => {
    expect(() => assertRequiredBunVersion(version)).toThrow(
      `bunqueue-dashboard requires Bun ${REQUIRED_BUN_VERSION}; received ${version}`
    );
  });
});
