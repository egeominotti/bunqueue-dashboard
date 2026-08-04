import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import {
  type AlertRule,
  MAX_ALERT_RULES,
  useAlertsStore,
} from '../src/components/dashboard/stores/alertsStore';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { useToastStore } from '../src/components/dashboard/stores/toastStore';
import { alertConnectionIdentity, useAlertRuntimeStore } from '../src/lib/useAlertEngine';
import { Alerts, channelTargetError } from '../src/pages/Alerts';
import { ensureDom, settle } from './domSetup';

// Regression tests for the audited alert-engine / connection-store defects:
// unknown-is-not-resolved on a partial fetch failure, a cooldown that defers
// instead of dropping, identity reconciliation while the server is down, the
// paginated dlq source, the same-tick toast burst, and trailing-slash trimming.

const rule = (over: Partial<AlertRule>): AlertRule => ({
  id: 'r1',
  name: 'test rule',
  metric: 'waiting',
  operator: '>=',
  threshold: 5,
  queue: '',
  channel: 'email',
  enabled: true,
  ...over,
});

let waiting = 10;
let completed = 90;
let failed = 10;
let failSummary = false;
let failOverview = false;
let queueCount = 1;
let emptyPercentiles = false;
const realFetch = globalThis.fetch;

function route(url: string): Response {
  if (url.includes('/queues/summary')) {
    if (failSummary) return Response.json({ ok: false, error: 'boom' }, { status: 500 });
    return Response.json([
      {
        name: 'q1',
        paused: false,
        counts: {
          waiting,
          prioritized: 0,
          active: 0,
          completed,
          failed,
          delayed: 0,
        },
      },
    ]);
  }
  if (url.includes('/dashboard/queues')) {
    // Paginated exactly like bunqueue: `total` is the full count, the page is a
    // window of it — so an engine that reads only page 1 misses the tail.
    const params = new URL(url, 'http://x').searchParams;
    const limit = Number(params.get('limit') ?? 500);
    const offset = Number(params.get('offset') ?? 0);
    const all = Array.from({ length: queueCount }, (_, i) => ({ name: `q${i + 1}`, dlq: 7 }));
    return Response.json({
      ok: true,
      queues: all.slice(offset, offset + limit),
      total: all.length,
      limit,
      offset,
    });
  }
  if (url.endsWith('/dashboard')) {
    if (failOverview) return Response.json({ ok: false, error: 'down' }, { status: 500 });
    return Response.json({
      ok: true,
      latency: { percentiles: emptyPercentiles ? {} : { push: { p99: 120 } } },
    });
  }
  return Response.json({ ok: true });
}

beforeEach(() => {
  waiting = 10;
  completed = 90;
  failed = 10;
  failSummary = false;
  failOverview = false;
  queueCount = 1;
  emptyPercentiles = false;
  globalThis.fetch = ((input: RequestInfo | URL) =>
    Promise.resolve(route(String(input)))) as typeof fetch;
  useAlertsStore.setState({ rules: [] });
  useAlertRuntimeStore.setState({
    breaching: [],
    status: 'idle',
    error: null,
    connectionIdentity: null,
  });
  useToastStore.setState({ toasts: [] });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  useAlertsStore.setState({ rules: [] });
  useConnectionStore.setState({ baseUrl: '/api', token: '' });
});

const _toasts = () => useToastStore.getState().toasts;
const _breaching = () => useAlertRuntimeStore.getState().breaching;

// A never-breaching filler rule whose id changes the enabled-rule signature,
// which re-arms the effect and runs an immediate extra tick — the test-side
// substitute for waiting out POLL_MS.
const filler = (n: number): AlertRule =>
  rule({ id: `pad${n}`, name: `pad${n}`, metric: 'dlq', operator: '>', threshold: 1e9 });

async function _retick(n: number, rules: AlertRule[]): Promise<void> {
  act(() => {
    useAlertsStore.setState({ rules: [...rules, filler(n)] });
  });
  await settle(10);
}

describe('alert configuration validation', () => {
  test('store callers receive an observable sanitization failure', () => {
    const result = useAlertsStore.getState().addRule({
      name: 'Hostile runtime value',
      metric: 'not-a-metric' as AlertRule['metric'],
      operator: '>=',
      threshold: 1,
      queue: '',
      channel: 'email',
      enabled: true,
    });

    expect(result).toEqual({ ok: false, error: 'Alert rule contains invalid fields.' });
    expect(useAlertsStore.getState().rules).toEqual([]);
  });

  test('the Alerts page never describes an unknown evaluation as all clear', () => {
    ensureDom();
    const activeRule = rule({ metric: 'error_rate', operator: '<', threshold: 1 });
    useConnectionStore.setState({ baseUrl: '/api', token: '' });
    useAlertsStore.setState({ rules: [activeRule] });
    useAlertRuntimeStore.setState({
      breaching: [],
      status: 'degraded',
      error: 'The rule has no observations yet.',
      connectionIdentity: alertConnectionIdentity('/api', ''),
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const rootView = createRoot(host);
    try {
      act(() => rootView.render(createElement(Alerts)));
      expect(host.textContent).not.toContain('All enabled rules are within their thresholds.');
      expect(host.textContent).toContain(
        'Alert metrics are unavailable; no all-clear result is available.'
      );
      expect(host.textContent).toContain('The rule has no observations yet.');
    } finally {
      act(() => rootView.unmount());
      host.remove();
    }
  });

  test('the 501st rule stays in the open form with an accessible error, then can be retried', async () => {
    ensureDom();
    useAlertsStore.setState({
      rules: Array.from({ length: MAX_ALERT_RULES }, (_, index) =>
        rule({ id: `full-${index}`, name: `full-${index}` })
      ),
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const rootView = createRoot(host);

    const setInput = (name: string, value: string) => {
      const input = host.querySelector<HTMLInputElement>(`input[name="${name}"]`);
      if (!input) throw new Error(`Missing ${name}`);
      act(() => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(
          input,
          value
        );
        const propsKey = Object.getOwnPropertyNames(input).find((key) =>
          key.startsWith('__reactProps$')
        );
        const props = propsKey
          ? ((input as unknown as Record<string, unknown>)[propsKey] as {
              onChange?: (event: {
                target: HTMLInputElement;
                currentTarget: HTMLInputElement;
              }) => void;
            })
          : null;
        if (!props?.onChange) throw new Error(`Missing onChange for ${name}`);
        props.onChange({ target: input, currentTarget: input });
      });
    };
    const click = (label: string) => {
      const button = [...host.querySelectorAll('button')].find((candidate) =>
        candidate.textContent?.includes(label)
      );
      if (!button) throw new Error(`Missing ${label}`);
      act(() => button.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    };

    try {
      act(() => rootView.render(createElement(Alerts)));
      click('Create Alert Rule');
      setInput('alert-rule-name', 'Capacity retry');
      setInput('alert-rule-threshold', '5');
      expect({
        disabled: [...host.querySelectorAll<HTMLButtonElement>('button')].find((candidate) =>
          candidate.textContent?.includes('Save rule')
        )?.disabled,
        name: host.querySelector<HTMLInputElement>('input[name="alert-rule-name"]')?.value,
        threshold: host.querySelector<HTMLInputElement>('input[name="alert-rule-threshold"]')
          ?.value,
      }).toEqual({ disabled: false, name: 'Capacity retry', threshold: '5' });
      click('Save rule');
      await settle(5);

      expect(useAlertsStore.getState().rules).toHaveLength(MAX_ALERT_RULES);
      expect(host.querySelector('#alert-rule-form')).not.toBeNull();
      expect(host.querySelector('[role="alert"]')?.textContent).toContain(
        `maximum of ${MAX_ALERT_RULES}`
      );

      act(() => {
        useAlertsStore.setState({ rules: useAlertsStore.getState().rules.slice(1) });
      });
      click('Save rule');
      await settle(5);
      expect(useAlertsStore.getState().rules).toHaveLength(MAX_ALERT_RULES);
      expect(useAlertsStore.getState().rules.at(-1)?.name).toBe('Capacity retry');
      expect(host.querySelector('#alert-rule-form')).toBeNull();
    } finally {
      act(() => rootView.unmount());
      host.remove();
    }
  });

  test('accepts valid destinations and rejects unsafe or malformed targets', () => {
    expect(channelTargetError('email', ' ops@example.com ')).toBeNull();
    expect(channelTargetError('email', 'not-an-email')).toContain('valid email');
    expect(channelTargetError('webhook', 'https://hooks.example/path')).toBeNull();
    expect(channelTargetError('slack', 'http://localhost:3000/hook')).toBeNull();
    expect(channelTargetError('webhook', 'javascript:alert(1)')).toContain('http://');
    expect(channelTargetError('webhook', 'https://user:pass@example.com/hook')).toContain(
      'without embedded credentials'
    );
  });
});
