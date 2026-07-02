import { describe, expect, test } from 'bun:test';
import {
  errorRate,
  formatBytes,
  formatDuration,
  formatNumber,
  formatPercent,
  formatRelativeTime,
  formatUptime,
  jobDuration,
} from '../src/lib/format';

describe('formatNumber', () => {
  test('groups thousands with a dot', () => {
    expect(formatNumber(14608)).toBe('14.608');
    expect(formatNumber(73181)).toBe('73.181');
  });
  test('nullish → "0"', () => {
    expect(formatNumber(undefined)).toBe('0');
    expect(formatNumber(null)).toBe('0');
    expect(formatNumber(Number.NaN)).toBe('0');
  });
});

describe('formatPercent', () => {
  test('fraction → percent', () => {
    expect(formatPercent(0.0123)).toBe('1.23%');
    expect(formatPercent(0.0006)).toBe('0.06%');
  });
  test('nullish → "0%"', () => {
    expect(formatPercent(undefined)).toBe('0%');
  });
});

describe('errorRate', () => {
  test('computes failed / total', () => {
    expect(errorRate(90, 10)).toBeCloseTo(0.1);
  });
  test('zero total → 0', () => {
    expect(errorRate(0, 0)).toBe(0);
  });
});

describe('formatDuration', () => {
  test('sub-second in ms', () => {
    expect(formatDuration(820)).toBe('820ms');
  });
  test('seconds', () => {
    expect(formatDuration(1400)).toBe('1.4s');
  });
  test('minutes', () => {
    expect(formatDuration(123000)).toBe('2m 3s');
  });
  test('rounding never yields "60.0s" or "Nm 60s"', () => {
    // 59.95–59.999s would render "60.0s" via toFixed(1) — must tip into minutes.
    expect(formatDuration(59949)).toBe('59.9s');
    expect(formatDuration(59950)).toBe('1m 0s');
    // 119.5–119.999s: independent rounding of the remainder gave "1m 60s".
    expect(formatDuration(119700)).toBe('2m 0s');
    expect(formatDuration(119400)).toBe('1m 59s');
  });
  test('unknown → "—"', () => {
    expect(formatDuration(undefined)).toBe('—');
    expect(formatDuration(-5)).toBe('—');
  });
});

describe('formatRelativeTime', () => {
  test('seconds / minutes / hours', () => {
    const now = 1_000_000_000;
    expect(formatRelativeTime(now - 5_000, now)).toBe('5s ago');
    expect(formatRelativeTime(now - 120_000, now)).toBe('2m ago');
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe('3h ago');
  });
  test('nullish → "—"', () => {
    expect(formatRelativeTime(undefined)).toBe('—');
  });
});

describe('jobDuration', () => {
  test('computes when both timestamps present', () => {
    expect(jobDuration(1000, 1820)).toBe(820);
  });
  test('undefined when missing or negative', () => {
    expect(jobDuration(undefined, 1820)).toBeUndefined();
    expect(jobDuration(2000, 1000)).toBeUndefined();
  });
});

describe('formatBytes / formatUptime', () => {
  test('bytes', () => {
    expect(formatBytes(165 * 1024 * 1024)).toBe('165.0 MB');
    expect(formatBytes(512)).toBe('512 B');
  });
  test('uptime', () => {
    expect(formatUptime(3 * 86400 + 4 * 3600 + 12 * 60)).toBe('3d 4h 12m');
    expect(formatUptime(undefined)).toBe('—');
  });
});
