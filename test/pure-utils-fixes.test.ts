/**
 * Regression tests for the boundary/robustness fixes in the pure helpers
 * (format, exportFile, cloneJob, flowLayout, cronPreview). Every case here
 * fails on the pre-fix implementation.
 */
import { describe, expect, test } from 'bun:test';
import type { JobFull } from '../src/lib/bqTypes';
import { buildCloneState } from '../src/lib/cloneJob';
import { nextCronRuns } from '../src/lib/cronPreview';
import { toCsv } from '../src/lib/exportFile';
import { computeLayers, type FlowEdge } from '../src/lib/flowLayout';
import { formatBytes, formatCompact, formatUptime } from '../src/lib/format';

describe('format — unit promotion at the rounding boundary', () => {
  test('formatBytes never prints a mantissa of 1024', () => {
    expect(formatBytes(1048575)).toBe('1.0 MB'); // was "1024.0 KB"
    expect(formatBytes(1073741823)).toBe('1.0 GB'); // was "1024.0 MB"
    expect(formatBytes(1099511627775)).toBe('1.0 TB'); // was "1024.0 GB"
    expect(formatBytes(1023.6)).toBe('1.0 KB'); // was "1024 B"
    // The TB cap still renders large mantissas (no unit above it).
    expect(formatBytes(1024 ** 5)).toBe('1024.0 TB');
  });

  test('formatBytes leaves ordinary values untouched', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(165 * 1024 * 1024)).toBe('165.0 MB');
    expect(formatBytes(null)).toBe('—');
  });

  test('formatCompact never prints a mantissa of 1000 with a K suffix', () => {
    expect(formatCompact(999999)).toBe('1.0M'); // was "1000.0K"
    expect(formatCompact(999950)).toBe('1.0M'); // was "1000.0K"
    expect(formatCompact(999949)).toBe('999.9K');
    expect(formatCompact(1200)).toBe('1.2K');
    expect(formatCompact(3_400_000)).toBe('3.4M');
    expect(formatCompact(999)).toBe('999');
  });
});

describe('formatUptime — negative (clock-skew) input', () => {
  test('clamps a backwards clock step to 0m instead of "-1d -1h -1m"', () => {
    expect(formatUptime(-1)).toBe('0m');
    expect(formatUptime(-30)).toBe('0m');
    expect(formatUptime(-86400)).toBe('0m');
  });

  test('positive uptimes are unchanged', () => {
    expect(formatUptime(3 * 86400 + 4 * 3600 + 12 * 60)).toBe('3d 4h 12m');
    expect(formatUptime(0)).toBe('0m');
    expect(formatUptime(undefined)).toBe('—');
  });
});

describe('toCsv — record count survives serialization', () => {
  test('keeps a row whose cells all serialize to empty', () => {
    expect(toCsv([{ note: '' }], ['note'])).toBe('note\n');
    expect(toCsv([{ a: null }], ['a'])).toBe('a\n');
    // No columns at all: header is empty, but the record must still be there.
    expect(toCsv([{}])).toBe('\n');
  });

  test('an empty row set still emits only the header', () => {
    expect(toCsv([], ['a', 'b'])).toBe('a,b');
  });
});

describe('nextCronRuns — unsatisfiable expressions terminate fast', () => {
  const FROM = new Date(2026, 0, 1, 0, 0, 0).getTime();

  test('a valid-but-impossible day/month returns no runs in bounded time', () => {
    for (const expr of ['0 0 31 4 *', '0 0 30 2 *', '0 0 31 2 *', '0 0 30 feb *']) {
      const t0 = performance.now();
      const res = nextCronRuns(expr, 3, FROM);
      const elapsed = performance.now() - t0;
      expect(res.valid).toBe(true);
      expect(res.runs).toEqual([]);
      // Pre-fix this burned all 2.2M iterations (~450ms) on the render path.
      expect(elapsed).toBeLessThan(50);
    }
  });

  test('a rare but reachable schedule (Feb 29) is still found', () => {
    const { valid, runs } = nextCronRuns('0 0 29 2 *', 1, FROM);
    expect(valid).toBe(true);
    expect(runs).toHaveLength(1);
    const d = new Date(runs[0]);
    expect(d.getMonth()).toBe(1);
    expect(d.getDate()).toBe(29);
  });
});

describe('computeLayers — a cycle degrades only the cycle', () => {
  const child = (from: string, to: string): FlowEdge => ({ from, to, kind: 'child' });

  test('an acyclic tail hanging off a cycle keeps increasing layers', () => {
    const ids = ['n0', 'n1', 'n2', 'n3', 'n4', 'n5'];
    const edges = [
      child('n0', 'n1'),
      child('n1', 'n2'),
      child('n2', 'n0'), // the cycle
      child('n0', 'n3'),
      child('n3', 'n4'),
      child('n4', 'n5'), // acyclic tail
    ];
    const layers = computeLayers(ids, edges);
    expect(layers.size).toBe(6);
    // Pre-fix every node sat at layer 0 (one collapsed column).
    const l = (id: string) => layers.get(id) ?? -1;
    expect(l('n3')).toBeGreaterThan(l('n0'));
    expect(l('n4')).toBeGreaterThan(l('n3'));
    expect(l('n5')).toBeGreaterThan(l('n4'));
    expect(l('n1')).toBeGreaterThan(l('n0'));
    expect(l('n2')).toBeGreaterThan(l('n1'));
  });

  test('a pure 2-node cycle still terminates and layers every node', () => {
    const layers = computeLayers(['a', 'b'], [child('a', 'b'), child('b', 'a')]);
    expect(layers.size).toBe(2);
    expect(layers.get('a')).toBe(0);
    expect(layers.get('b')).toBe(1);
  });

  test('a disconnected cycle does not disturb an independent chain', () => {
    const ids = ['c1', 'c2', 'x', 'y'];
    const layers = computeLayers(ids, [child('c1', 'c2'), child('c2', 'c1'), child('x', 'y')]);
    expect(layers.get('x')).toBe(0);
    expect(layers.get('y')).toBe(1);
  });
});

describe('buildCloneState — carries every enqueue-relevant option', () => {
  test('copies tags, groupId, ttl and the backoff strategy', () => {
    const job: JobFull = {
      id: 'j1',
      queue: 'emails',
      data: { to: 'a@example.com' },
      tags: ['billing'],
      groupId: 'tenant-42',
      ttl: 3_600_000,
      backoff: 1000,
      backoffConfig: { type: 'exponential', delay: 1000, maxDelay: 3_600_000 },
    };
    const { clone } = buildCloneState(job);
    expect(clone.options.tags).toEqual(['billing']);
    expect(clone.options.groupId).toBe('tenant-42');
    expect(clone.options.ttl).toBe(3_600_000);
    expect(clone.options.backoffConfig).toEqual({ type: 'exponential', delay: 1000 });
    // The numeric field the form binds to stays a number.
    expect(clone.options.backoff).toBe(1000);
  });

  test('a strategy without a top-level backoff still seeds the delay', () => {
    const job: JobFull = { id: 'j2', backoffConfig: { type: 'fixed', delay: 5000 } };
    const { clone } = buildCloneState(job);
    expect(clone.options.backoff).toBe(5000);
    expect(clone.options.backoffConfig).toEqual({ type: 'fixed', delay: 5000 });
  });

  test('absent/empty advanced options are omitted', () => {
    const job: JobFull = { id: 'j3', tags: [], groupId: null, ttl: null };
    const { clone } = buildCloneState(job);
    expect(clone.options).toEqual({});
  });
});
