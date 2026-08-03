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
import {
  alertConnectionIdentity,
  allQueues,
  parseAlertOverview,
  parseAlertQueueSummary,
  useAlertEngine,
  useAlertRuntimeStore,
} from '../src/lib/useAlertEngine';
import { Alerts, buildAlertRule, channelTargetError } from '../src/pages/Alerts';
import { ensureDom, renderHook, settle } from './domSetup';

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

const toasts = () => useToastStore.getState().toasts;
const breaching = () => useAlertRuntimeStore.getState().breaching;

// A never-breaching filler rule whose id changes the enabled-rule signature,
// which re-arms the effect and runs an immediate extra tick — the test-side
// substitute for waiting out POLL_MS.
const filler = (n: number): AlertRule =>
  rule({ id: `pad${n}`, name: `pad${n}`, metric: 'dlq', operator: '>', threshold: 1e9 });

async function retick(n: number, rules: AlertRule[]): Promise<void> {
  act(() => {
    useAlertsStore.setState({ rules: [...rules, filler(n)] });
  });
  await settle(10);
}

describe('alert engine — audited fixes', () => {
  test('retargeting the connection clears server A runtime and notification latches', async () => {
    useConnectionStore.setState({ baseUrl: 'http://server-a', token: 'token-a' });
    const rules = [rule({ metric: 'waiting', threshold: 5 })];
    useAlertsStore.setState({ rules });

    let blockServerB = true;
    const releaseServerB: Array<() => void> = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (blockServerB && url.startsWith('http://server-b/')) {
        return new Promise<Response>((resolve) => {
          releaseServerB.push(() => resolve(route(url)));
        });
      }
      return Promise.resolve(route(url));
    }) as typeof fetch;

    const h = renderHook(() => useAlertEngine());
    await settle(10);
    expect(breaching().map((breach) => breach.ruleId)).toEqual(['r1']);
    expect(toasts()).toHaveLength(1);
    expect(useAlertRuntimeStore.getState().status).toBe('live');

    act(() => {
      useConnectionStore.setState({ baseUrl: 'http://server-b', token: 'token-b' });
    });
    expect(releaseServerB).toHaveLength(3);
    expect(breaching()).toEqual([]);
    expect(useAlertRuntimeStore.getState().status).toBe('checking');
    expect(toasts()).toHaveLength(1);

    blockServerB = false;
    for (const release of releaseServerB) release();
    await settle(10);
    expect(breaching().map((breach) => breach.ruleId)).toEqual(['r1']);
    // Same rule, but a different backend: A's cooldown/edge state must not
    // suppress the first alert evaluation from B.
    expect(toasts()).toHaveLength(2);
    expect(useAlertRuntimeStore.getState().status).toBe('live');
    h.unmount();
  });

  test('retargeting between queue pages never mixes URL/bearer targets or publishes stale facts', async () => {
    useConnectionStore.setState({ baseUrl: 'http://server-a', token: 'token-a' });
    useAlertsStore.setState({
      rules: [rule({ metric: 'dlq', queue: 'q600', threshold: 5 })],
    });

    const requests: Array<{ url: string; authorization: string | null }> = [];
    let switched = false;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const parsedUrl = new URL(url);
      const authorization = new Headers(init?.headers).get('Authorization');
      requests.push({ url, authorization });

      let response: Response;
      if (parsedUrl.pathname.endsWith('/queues/summary')) {
        response = Response.json([
          {
            name: 'q600',
            paused: false,
            counts: {
              waiting: 0,
              prioritized: 0,
              active: 0,
              completed: 0,
              failed: 0,
              delayed: 0,
            },
          },
        ]);
      } else if (parsedUrl.pathname.endsWith('/dashboard/queues')) {
        const limit = Number(parsedUrl.searchParams.get('limit'));
        const offset = Number(parsedUrl.searchParams.get('offset'));
        if (parsedUrl.origin === 'http://server-a') {
          const queues = Array.from({ length: Math.min(500, 600 - offset) }, (_, index) => ({
            name: `q${offset + index + 1}`,
            dlq: offset + index === 599 ? 7 : 0,
          }));
          response = Response.json({ ok: true, queues, total: 600, limit, offset });
        } else if (offset === 0) {
          // Server B's complete snapshot is explicitly within threshold.
          response = Response.json({
            ok: true,
            queues: [{ name: 'q600', dlq: 0 }],
            total: 1,
            limit,
            offset,
          });
        } else {
          // A stale global-client walk would request this continuation from B.
          // Keep it structurally compatible with A so mixed data could appear
          // trustworthy; the pinned/lifecycle implementation must never ask.
          const queues = Array.from({ length: 100 }, (_, index) => ({
            name: `q${offset + index + 1}`,
            dlq: index === 99 ? 7 : 0,
          }));
          response = Response.json({ ok: true, queues, total: 600, limit, offset });
        }
      } else if (parsedUrl.pathname.endsWith('/dashboard')) {
        response = Response.json({
          ok: true,
          latency: { percentiles: { push: { p99: 1 } } },
        });
      } else {
        response = Response.json({ error: 'unexpected request' }, { status: 500 });
      }

      if (
        !switched &&
        parsedUrl.origin === 'http://server-a' &&
        parsedUrl.pathname.endsWith('/dashboard/queues') &&
        parsedUrl.searchParams.get('offset') === '0'
      ) {
        switched = true;
        // Resolve page A/0 only after Settings selects B. A client that reads
        // Settings per page will continue this same walk at B/500 with token B.
        return Promise.resolve(response).then((value) => {
          act(() => {
            useConnectionStore.setState({ baseUrl: 'http://server-b', token: 'token-b' });
          });
          return value;
        });
      }
      return Promise.resolve(response);
    }) as typeof fetch;

    const h = renderHook(() => useAlertEngine());
    await settle(50);

    expect(switched).toBe(true);
    expect(
      requests.some(({ url }) => {
        const parsedUrl = new URL(url);
        return (
          parsedUrl.origin === 'http://server-b' &&
          parsedUrl.pathname.endsWith('/dashboard/queues') &&
          parsedUrl.searchParams.get('offset') === '500'
        );
      })
    ).toBe(false);
    expect(
      requests
        .filter(({ url }) => url.startsWith('http://server-a/'))
        .every(({ authorization }) => authorization === 'Bearer token-a')
    ).toBe(true);
    expect(
      requests
        .filter(({ url }) => url.startsWith('http://server-b/'))
        .every(({ authorization }) => authorization === 'Bearer token-b')
    ).toBe(true);
    expect(useAlertRuntimeStore.getState()).toMatchObject({
      breaching: [],
      status: 'live',
      error: null,
      connectionIdentity: alertConnectionIdentity('http://server-b', 'token-b'),
    });
    expect(toasts()).toEqual([]);
    h.unmount();
  });

  test('a source failure keeps the known breach published (unknown ≠ all clear)', async () => {
    const rules = [rule({ metric: 'waiting', threshold: 5 })];
    useAlertsStore.setState({ rules });
    const h = renderHook(() => useAlertEngine());
    await settle(10);
    expect(breaching().map((b) => b.ruleId)).toEqual(['r1']);

    // /queues/summary starts failing while the server is otherwise up.
    failSummary = true;
    await retick(1, rules);
    expect(breaching().map((b) => b.ruleId)).toEqual(['r1']);
    expect(breaching()[0]?.value).toBe(10);
    h.unmount();
  });

  test('zero-sample queue and global error rates stay unknown for both inequality directions', async () => {
    completed = 0;
    failed = 0;
    useAlertsStore.setState({
      rules: [
        rule({
          id: 'queue-less-than',
          metric: 'error_rate',
          operator: '<',
          threshold: 1,
          queue: 'q1',
        }),
        rule({
          id: 'global-greater-than',
          metric: 'error_rate',
          operator: '>',
          threshold: 1,
          queue: '',
        }),
      ],
    });

    const h = renderHook(() => useAlertEngine());
    await settle(10);

    expect(breaching()).toEqual([]);
    expect(useAlertRuntimeStore.getState()).toMatchObject({
      status: 'degraded',
      error: 'Some alert rules could not be evaluated; affected results remain unknown.',
    });
    expect(toasts()).toEqual([]);
    h.unmount();
  });

  test('missing queues and empty percentile sets cannot publish an all-clear status', async () => {
    emptyPercentiles = true;
    useAlertsStore.setState({
      rules: [
        rule({
          id: 'missing-queue',
          metric: 'waiting',
          operator: '<',
          threshold: 1,
          queue: 'does-not-exist',
        }),
        rule({
          id: 'empty-p99',
          metric: 'p99_latency',
          operator: '>',
          threshold: 1,
          queue: '',
        }),
      ],
    });

    const h = renderHook(() => useAlertEngine());
    await settle(10);

    expect(breaching()).toEqual([]);
    expect(useAlertRuntimeStore.getState().status).toBe('degraded');
    expect(useAlertRuntimeStore.getState().error).toContain('remain unknown');
    h.unmount();
  });

  test('the cooldown defers a suppressed edge instead of dropping it forever', async () => {
    const realNow = Date.now;
    let clock = 1_000_000;
    Date.now = () => clock;
    try {
      const rules = [rule({ metric: 'waiting', threshold: 5 })];
      useAlertsStore.setState({ rules });
      const h = renderHook(() => useAlertEngine());
      await settle(10);
      expect(toasts()).toHaveLength(1);

      // Dips below the threshold for one tick …
      clock += 15_000;
      waiting = 0;
      await retick(1, rules);
      expect(breaching()).toHaveLength(0);

      // … then re-breaches inside the 60 s cooldown: suppressed, not consumed.
      clock += 15_000;
      waiting = 10;
      await retick(2, rules);
      expect(breaching()).toHaveLength(1);
      expect(toasts()).toHaveLength(1);

      // Still breaching once the cooldown has expired ⇒ exactly one notification.
      clock += 70_000;
      await retick(3, rules);
      expect(toasts()).toHaveLength(2);

      // …and not a second one for the same episode.
      clock += 70_000;
      await retick(4, rules);
      expect(toasts()).toHaveLength(2);
      h.unmount();
    } finally {
      Date.now = realNow;
    }
  });

  test('a rule deleted while the server is down loses its triggered row', async () => {
    const a = rule({ id: 'a', name: 'noisy', metric: 'waiting', threshold: 5 });
    const b = rule({ id: 'b', name: 'quiet', metric: 'dlq', operator: '>', threshold: 1e9 });
    useAlertsStore.setState({ rules: [a, b] });
    const h = renderHook(() => useAlertEngine());
    await settle(10);
    expect(breaching().map((x) => x.ruleId)).toEqual(['a']);

    failOverview = true;
    act(() => {
      useAlertsStore.setState({ rules: [b] });
    });
    await settle(10);
    expect(breaching()).toEqual([]);
    h.unmount();
  });

  test('the dlq metric sees queues beyond the first page', async () => {
    queueCount = 600; // > bq.queues()'s default limit of 500
    useAlertsStore.setState({
      rules: [rule({ id: 'tail', metric: 'dlq', queue: 'q600', threshold: 5 })],
    });
    const h = renderHook(() => useAlertEngine());
    await settle(20);
    expect(breaching().map((x) => x.ruleId)).toEqual(['tail']);
    expect(breaching()[0]?.value).toBe(7);
    h.unmount();
  });

  test('allQueues uses a supplied pinned client for every continuation page', async () => {
    const offsets: number[] = [];
    const client = {
      queues: async (limit = 500, offset = 0) => {
        offsets.push(offset);
        if (offset === 0) {
          useConnectionStore.setState({ baseUrl: 'http://server-b', token: 'token-b' });
        }
        const queues = Array.from({ length: Math.min(limit, 600 - offset) }, (_, index) => ({
          name: `q${offset + index + 1}`,
          waiting: 0,
          delayed: 0,
          active: 0,
          dlq: 0,
          paused: false,
        }));
        return { ok: true as const, queues, total: 600, limit, offset, timestamp: 0 };
      },
    };

    expect(await allQueues(client)).toHaveLength(600);
    expect(offsets).toEqual([0, 500]);
  });

  test('queue pagination returns unknown instead of an incomplete global DLQ total', async () => {
    queueCount = 11_000; // exceeds the explicit 10,500-row safety cap
    expect(await allQueues()).toBeNull();
  });

  test('queue pagination rejects missing, non-finite, fractional, and negative totals', async () => {
    for (const total of [undefined, Number.NaN, Number.POSITIVE_INFINITY, '1', 1.5, -1]) {
      globalThis.fetch = ((input: RequestInfo | URL) => {
        const params = new URL(String(input), 'http://x').searchParams;
        return Promise.resolve(
          Response.json({
            ok: true,
            queues: [],
            ...(total === undefined ? {} : { total }),
            limit: Number(params.get('limit')),
            offset: Number(params.get('offset')),
          })
        );
      }) as typeof fetch;
      expect(await allQueues()).toBeNull();
    }
  });

  test('queue pagination rejects a duplicate overlap that would otherwise reach total', async () => {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const params = new URL(String(input), 'http://x').searchParams;
      const limit = Number(params.get('limit'));
      const offset = Number(params.get('offset'));
      const queues =
        offset === 0
          ? Array.from({ length: 500 }, (_, index) => ({ name: `q${index}`, dlq: 0 }))
          : Array.from({ length: 100 }, (_, index) => ({ name: `q${400 + index}`, dlq: 0 }));
      return Promise.resolve(Response.json({ ok: true, queues, total: 600, limit, offset }));
    }) as typeof fetch;

    expect(await allQueues()).toBeNull();
  });

  test('queue pagination rejects a short continuation instead of publishing a partial snapshot', async () => {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const params = new URL(String(input), 'http://x').searchParams;
      const limit = Number(params.get('limit'));
      const offset = Number(params.get('offset'));
      const length = offset === 0 ? 500 : 50;
      const queues = Array.from({ length }, (_, index) => ({
        name: `q${offset + index}`,
        dlq: 0,
      }));
      return Promise.resolve(Response.json({ ok: true, queues, total: 600, limit, offset }));
    }) as typeof fetch;

    expect(await allQueues()).toBeNull();
  });

  test('queue pagination rejects a total that changes between pages', async () => {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const params = new URL(String(input), 'http://x').searchParams;
      const limit = Number(params.get('limit'));
      const offset = Number(params.get('offset'));
      const total = offset === 0 ? 600 : 550;
      const length = offset === 0 ? 500 : 50;
      const queues = Array.from({ length }, (_, index) => ({
        name: `q${offset + index}`,
        dlq: 0,
      }));
      return Promise.resolve(Response.json({ ok: true, queues, total, limit, offset }));
    }) as typeof fetch;

    expect(await allQueues()).toBeNull();
  });

  test('malformed summary and overview payloads never become live alert facts', () => {
    expect(parseAlertQueueSummary({})).toBeNull();
    expect(
      parseAlertQueueSummary([
        {
          name: 'orders',
          paused: false,
          counts: { waiting: '5', active: 0, completed: 0, failed: 0, delayed: 0 },
        },
      ])
    ).toBeNull();
    expect(parseAlertOverview({ ok: true })).toBeNull();
    expect(
      parseAlertOverview({
        ok: true,
        latency: { percentiles: { push: { p99: Number.NaN } } },
      })
    ).toBeNull();
    expect(
      parseAlertOverview({ ok: true, latency: { percentiles: { push: { p99: 12 } } } })
    ).not.toBeNull();
  });

  test('a same-tick burst collapses into one toast instead of self-evicting', async () => {
    useAlertsStore.setState({
      rules: Array.from({ length: 6 }, (_, i) =>
        rule({ id: `b${i}`, name: `burst ${i}`, metric: 'waiting', threshold: 5 })
      ),
    });
    const h = renderHook(() => useAlertEngine());
    await settle(10);
    expect(breaching()).toHaveLength(6);
    // Before the fix: 6 pushes → slice(-5) evicted "burst 0" before it rendered.
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0]?.title).toBe('6 alert rules breaching');
    expect(toasts()[0]?.detail).toContain('burst 0');
    h.unmount();
  });
});

describe('connectionStore.setBaseUrl', () => {
  test('strips every trailing slash (and surrounding whitespace)', () => {
    const set = useConnectionStore.getState().setBaseUrl;
    set('http://host:6790//');
    expect(useConnectionStore.getState().baseUrl).toBe('http://host:6790');
    set('  http://host:6790///  ');
    expect(useConnectionStore.getState().baseUrl).toBe('http://host:6790');
    set('/api');
    expect(useConnectionStore.getState().baseUrl).toBe('/api');
  });
});

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

  test('normalizes valid rules and rejects invalid bounds and runtime enum values', () => {
    const draft = {
      name: ' Waiting high ',
      metric: 'waiting' as const,
      operator: '>=' as const,
      threshold: '5',
      queue: ' orders ',
      channel: 'email' as const,
    };
    expect(buildAlertRule(draft)).toEqual({
      ok: true,
      rule: {
        name: 'Waiting high',
        metric: 'waiting',
        operator: '>=',
        threshold: 5,
        queue: 'orders',
        channel: 'email',
        enabled: true,
      },
    });
    expect(buildAlertRule({ ...draft, threshold: '-1' })).toMatchObject({ ok: false });
    expect(buildAlertRule({ ...draft, threshold: '1.5' })).toMatchObject({ ok: false });
    expect(buildAlertRule({ ...draft, metric: 'error_rate', threshold: '100.1' })).toMatchObject({
      ok: false,
    });
    expect(buildAlertRule({ ...draft, queue: 'bad queue' })).toMatchObject({ ok: false });
    expect(buildAlertRule({ ...draft, metric: 'hostile' as 'waiting' })).toEqual({
      ok: false,
      field: 'metric',
      error: 'Invalid metric',
    });
    expect(buildAlertRule({ ...draft, operator: '!=' as '>=' })).toEqual({
      ok: false,
      field: 'operator',
      error: 'Invalid operator',
    });
  });

  test('p99 latency is always global even when a stale queue value remains', () => {
    expect(
      buildAlertRule({
        name: 'Latency',
        metric: 'p99_latency',
        operator: '>',
        threshold: '250',
        queue: 'stale queue value',
        channel: 'email',
      })
    ).toMatchObject({ ok: true, rule: { queue: '' } });
  });
});
