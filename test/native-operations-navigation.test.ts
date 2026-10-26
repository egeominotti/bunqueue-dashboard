import { expect, test } from 'bun:test';
import { titleFor } from '../src/components/layout/pageTitle';
import { NAV } from '../src/components/layout/Sidebar';

test('makes discovery routes reachable in navigation with their own document titles', () => {
  const paths = NAV.flatMap((group) => group.items.map((item) => item.to));
  expect(paths).toContain('/search');
  expect(paths).toContain('/failures');
  expect(paths).toContain('/metrics/history');
  expect(paths).toContain('/monitoring');
  expect(titleFor('/search')).toBe('Global search');
  expect(titleFor('/failures')).toBe('Failure diagnostics');
  expect(titleFor('/metrics/history')).toBe('Native metric history');
  expect(titleFor('/monitoring')).toBe('Monitoring setup');
});
