import { describe, expect, test } from 'bun:test';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { App } from '../src/App';
import { NotFound } from '../src/pages/NotFound';

const EXPECTED_PATHS = [
  '/',
  '/fleet',
  '/overview-classic',
  '/queues',
  '/queues-classic',
  '/queues/:name',
  '/queues-classic/:name',
  '/jobs',
  '/jobs-classic',
  '/dlq',
  '/dlq-classic',
  '/cron',
  '/cron-classic',
  '/flows',
  '/workflows',
  '/workflows/executions',
  '/workflows/waiting',
  '/workflows/compensation',
  '/workflows/archive',
  '/metrics',
  '/metrics-classic',
  '/workers',
  '/workers-classic',
  '/logs',
  '/logs-classic',
  '/server',
  '/add-job',
  '/jobs/bulk-add',
  '/job',
  '/queue-control',
  '/cron-manager',
  '/dlq-control',
  '/webhooks',
  '/diagnostics',
  '/alerts',
  '/benchmark',
  '/database',
  '/mcp',
  '/usage',
  '/usage-classic',
  '/s3',
  '/s3-classic',
  '/settings',
  '*',
] as const;

function childrenOf(node: ReactElement): ReactElement[] {
  const children = (node.props as { children?: ReactNode }).children;
  const values = Array.isArray(children) ? children : [children];
  return values.filter(isValidElement);
}

describe('application route contract', () => {
  test('registers every documented direct, classic, workflow and fallback route exactly once', () => {
    const tree = App();
    expect(tree.type).toBe(Routes);
    const layout = childrenOf(tree)[0];
    if (!layout) throw new Error('Layout route missing');
    expect(layout.type).toBe(Route);
    const routes = childrenOf(layout);
    const paths = routes.map((route) => (route.props as { path?: string }).path);
    expect(paths).toEqual([...EXPECTED_PATHS]);
    expect(new Set(paths).size).toBe(paths.length);
  });

  test('keeps the legacy cron alias as a replacing redirect', () => {
    const layout = childrenOf(App())[0];
    if (!layout) throw new Error('Layout route missing');
    const alias = childrenOf(layout).find(
      (route) => (route.props as { path?: string }).path === '/cron-manager'
    );
    const redirect = alias && (alias.props as { element?: ReactElement }).element;
    expect(redirect?.type).toBe(Navigate);
    expect(redirect?.props).toMatchObject({ to: '/cron', replace: true });
  });

  test('keeps the wildcard route on the dedicated not-found page', () => {
    const layout = childrenOf(App())[0];
    if (!layout) throw new Error('Layout route missing');
    const fallback = childrenOf(layout).find(
      (route) => (route.props as { path?: string }).path === '*'
    );
    const element = fallback && (fallback.props as { element?: ReactElement }).element;
    expect(element?.type).toBe(NotFound);
  });
});
