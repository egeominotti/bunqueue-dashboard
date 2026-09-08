import { describe, expect, test } from 'bun:test';
import { CRITICAL_COVERAGE, criticalCoverageFailures } from '../scripts/criticalCoveragePolicy';

const complete = Object.keys(CRITICAL_COVERAGE)
  .map((path) => `SF:${path}\nLF:100\nLH:100\nFNF:100\nFNH:100\nend_of_record\n`)
  .join('');

describe('critical coverage gate', () => {
  test('accepts measured coverage, including absolute platform paths', () => {
    expect(criticalCoverageFailures(complete)).toEqual([]);
    expect(criticalCoverageFailures(complete.replaceAll('SF:', 'SF:C:\\repo\\'))).toEqual([]);
  });

  test('a critical regression fails even when the aggregate is otherwise perfect', () => {
    const report = `${complete.replace('LH:100', 'LH:20')}SF:unrelated.ts\nLF:99999\nLH:99999\nFNF:999\nFNH:999\nend_of_record`;
    expect(criticalCoverageFailures(report)).toHaveLength(1);
    expect(criticalCoverageFailures(complete.replace('FNH:100', 'FNH:0'))).toHaveLength(1);
  });

  test('missing, duplicate and malformed records fail closed', () => {
    expect(criticalCoverageFailures('')).toHaveLength(Object.keys(CRITICAL_COVERAGE).length);
    expect(criticalCoverageFailures(complete + complete)).toHaveLength(
      Object.keys(CRITICAL_COVERAGE).length
    );
    for (const bad of ['oops', '-1', '1000']) {
      expect(criticalCoverageFailures(complete.replace('LH:100', `LH:${bad}`))).toHaveLength(1);
    }
    expect(criticalCoverageFailures(complete.replace('LF:100', 'LF:0'))).toHaveLength(1);
  });
});
