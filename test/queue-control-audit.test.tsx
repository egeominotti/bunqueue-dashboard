import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { bq } from '../src/lib/bq';
import {
  actionResultCount,
  loadAllQueuePages,
  QueueControl,
  resolveQueueSelection,
} from '../src/pages/control/QueueControl';
import {
  DlqConfigForm,
  dlqConfigMutationPayload,
  StallForm,
  stallConfigPayload,
} from '../src/pages/control/queue/ConfigForms';
import {
  concurrencyArgs,
  LifecycleCard,
  promoteConfirmation,
  type RunAction,
  rateLimitArgs,
} from '../src/pages/control/queue/QueueActions';
import { ensureDom, settle } from './domSetup';

const realFetch = globalThis.fetch;
const mounted = new Set<() => void>();

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'content-type': 'application/json' } });

const stallConfig = {
  enabled: true,
  stallInterval: 30_000,
  maxStalls: 3,
  gracePeriod: 5_000,
};

const dlqConfig = {
  autoRetry: false,
  autoRetryInterval: 3_600_000,
  maxAutoRetries: 3,
  maxAge: 604_800_000,
  maxEntries: 10_000,
};

function queueEntry(name: string) {
  return { name, waiting: 0, delayed: 0, active: 0, dlq: 0, paused: false };
}

function queuePage(names: string[], offset = 0, total = names.length) {
  return {
    ok: true,
    queues: names.map(queueEntry),
    total,
    limit: 500,
    offset,
    timestamp: 1,
  };
}

function queueDetail(name: string, waiting = 1) {
  return {
    ok: true,
    name,
    counts: {
      waiting,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
      prioritized: 0,
      'waiting-children': 0,
      paused: 0,
    },
    paused: false,
    priorityCounts: {},
    dlqPreview: [],
    timestamp: 1,
  };
}

function queueSummaryEntry(name: string) {
  return {
    name,
    paused: false,
    counts: { waiting: 1, prioritized: 0, active: 0, completed: 0, failed: 0, delayed: 0 },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function render(element: ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  let active = true;
  const unmount = () => {
    if (!active) return;
    active = false;
    act(() => root.unmount());
    host.remove();
    mounted.delete(unmount);
  };
  mounted.add(unmount);
  act(() => root.render(element));
  return { host, unmount };
}

function renderControl() {
  return render(createElement(MemoryRouter, null, createElement(QueueControl)));
}

function findButton(host: HTMLElement, text: string, index = 0): HTMLButtonElement {
  const buttons = [...host.querySelectorAll('button')].filter((button) =>
    (button.textContent ?? '').includes(text)
  );
  const button = buttons[index];
  if (!button) throw new Error(`No button matching "${text}" at index ${index}`);
  return button;
}

function click(host: HTMLElement, text: string, index = 0) {
  const button = findButton(host, text, index);
  act(() => button.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
}

function setValue(element: HTMLInputElement | HTMLSelectElement, value: string) {
  act(() => {
    const prototype =
      element instanceof window.HTMLSelectElement
        ? window.HTMLSelectElement.prototype
        : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
    element.dispatchEvent(new window.Event('input', { bubbles: true }));
    element.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}

beforeEach(() => {
  ensureDom();
  useConnectionStore.setState({
    baseUrl: 'http://server.test',
    token: '',
    agentToken: '',
    refreshMs: 3_000,
  });
});

afterEach(() => {
  for (const unmount of [...mounted]) unmount();
  globalThis.fetch = realFetch;
  useConnectionStore.setState({
    baseUrl: '/api',
    token: '',
    agentToken: '',
    refreshMs: 3_000,
  });
});

describe('QueueControl v2.8.55 discovery and response integrity', () => {
  test('loads every 500-item discovery page', async () => {
    const names = Array.from({ length: 501 }, (_, index) => `q-${index}`);
    const offsets: number[] = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const offset = Number(url.searchParams.get('offset'));
      offsets.push(offset);
      const pageNames = names.slice(offset, offset + 500);
      return Promise.resolve(json(queuePage(pageNames, offset, names.length)));
    }) as typeof fetch;

    const result = await loadAllQueuePages();
    expect(offsets).toEqual([0, 500]);
    expect(result.queues).toHaveLength(501);
    expect(result.queues.at(-1)?.name).toBe('q-500');
  });

  test('bounds a moving total instead of chasing a growing queue set', async () => {
    const offsets: number[] = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const offset = Number(url.searchParams.get('offset'));
      offsets.push(offset);
      if (offset === 0) {
        return Promise.resolve(
          json(
            queuePage(
              Array.from({ length: 500 }, (_, index) => `q-${index}`),
              0,
              501
            )
          )
        );
      }
      return Promise.resolve(
        json(
          queuePage(
            Array.from({ length: 500 }, (_, index) => `q-${500 + index}`),
            500,
            1_001
          )
        )
      );
    }) as typeof fetch;

    await expect(loadAllQueuePages()).rejects.toThrow(
      'total moved from 501 to 1001. Retry the snapshot.'
    );
    expect(offsets).toEqual([0, 500]);
  });

  test('rejects changed offsets and overlapping pages without another fetch', async () => {
    const firstNames = Array.from({ length: 500 }, (_, index) => `q-${index}`);
    let mode: 'offset' | 'overlap' = 'offset';
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      if (calls % 2 === 1) return Promise.resolve(json(queuePage(firstNames, 0, 501)));
      return Promise.resolve(json(queuePage(['q-499'], mode === 'offset' ? 499 : 500, 501)));
    }) as typeof fetch;

    await expect(loadAllQueuePages()).rejects.toThrow('Malformed /dashboard/queues response.');
    expect(calls).toBe(2);

    mode = 'overlap';
    await expect(loadAllQueuePages()).rejects.toThrow('queue "q-499" appeared more than once');
    expect(calls).toBe(4);
  });

  test('rejects an impractically large first snapshot before requesting page two', async () => {
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      return Promise.resolve(
        json(
          queuePage(
            Array.from({ length: 500 }, (_, index) => `q-${index}`),
            0,
            100_001
          )
        )
      );
    }) as typeof fetch;

    await expect(loadAllQueuePages()).rejects.toThrow('safe dashboard limit of 100000');
    expect(calls).toBe(1);
  });

  test('a selection removed by discovery retargets deterministically', () => {
    expect(resolveQueueSelection('q-b', [{ name: 'q-a' }, { name: 'q-b' }])).toBe('q-b');
    expect(resolveQueueSelection('removed', [{ name: 'q-a' }, { name: 'q-b' }])).toBe('q-a');
    expect(resolveQueueSelection('removed', [])).toBe('');
  });

  test('an incomplete 2xx queue-detail body becomes a readable error', async () => {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/dashboard/queues') return Promise.resolve(json(queuePage(['q-a'])));
      if (url.pathname === '/dashboard/queues/q-a') return Promise.resolve(json({ ok: true }));
      if (url.pathname.endsWith('/stall-config')) {
        return Promise.resolve(json({ ok: true, config: stallConfig }));
      }
      if (url.pathname.endsWith('/dlq-config')) {
        return Promise.resolve(json({ ok: true, config: dlqConfig }));
      }
      return Promise.resolve(json({ ok: false, error: 'unexpected request' }, 500));
    }) as typeof fetch;

    const { host } = renderControl();
    await settle(35);
    expect(host.textContent).toContain('Something went wrong');
    expect(host.textContent).toContain('Malformed queue detail response for "q-a"');
    expect(host.textContent).not.toContain('ActiveWaiting');
  });

  test('a late detail response cannot retarget the selected queue', async () => {
    const oldDetail = deferred<Response>();
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/dashboard/queues') {
        return Promise.resolve(json(queuePage(['q-a', 'q-b'])));
      }
      if (url.pathname === '/dashboard/queues/q-a') return oldDetail.promise;
      if (url.pathname === '/dashboard/queues/q-b') {
        return Promise.resolve(json(queueDetail('q-b', 22)));
      }
      if (url.pathname.endsWith('/stall-config')) {
        return Promise.resolve(json({ ok: true, config: stallConfig }));
      }
      if (url.pathname.endsWith('/dlq-config')) {
        return Promise.resolve(json({ ok: true, config: dlqConfig }));
      }
      return Promise.resolve(json({ ok: false, error: 'unexpected request' }, 500));
    }) as typeof fetch;

    const { host } = renderControl();
    await settle(20);
    const picker = host.querySelector('[name="queue-control-queue"]') as HTMLSelectElement;
    setValue(picker, 'q-b');
    await settle(20);
    expect(host.textContent).toContain('22');

    await act(async () => {
      oldDetail.resolve(json(queueDetail('q-a', 99)));
      await new Promise((resolve) => setTimeout(resolve, 8));
    });
    expect(picker.value).toBe('q-b');
    expect(host.textContent).toContain('22');
    expect(host.textContent).not.toContain('99');
  });

  test('a malformed refresh keeps the last snapshot and marks it stale', async () => {
    useConnectionStore.setState({ refreshMs: 20 });
    let detailCalls = 0;
    const malformedRefresh = deferred<Response>();
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/dashboard/queues') return Promise.resolve(json(queuePage(['q-a'])));
      if (url.pathname === '/dashboard/queues/q-a') {
        detailCalls += 1;
        return detailCalls === 1
          ? Promise.resolve(json(queueDetail('q-a', 17)))
          : malformedRefresh.promise;
      }
      if (url.pathname.endsWith('/stall-config')) {
        return Promise.resolve(json({ ok: true, config: stallConfig }));
      }
      if (url.pathname.endsWith('/dlq-config')) {
        return Promise.resolve(json({ ok: true, config: dlqConfig }));
      }
      return Promise.resolve(json({ ok: false, error: 'unexpected request' }, 500));
    }) as typeof fetch;

    const { host, unmount } = renderControl();
    await settle(20);
    await settle(30);
    expect(host.textContent).toContain('17');
    expect(host.textContent).toContain('prioritized');
    expect(host.textContent).toContain('waiting-children');
    expect(detailCalls).toBe(2);

    await act(async () => {
      malformedRefresh.resolve(json({ ok: true }));
      await new Promise((resolve) => setTimeout(resolve, 8));
    });
    expect(host.textContent).toContain('Queue refresh failed');
    expect(host.textContent).toContain('17');
    expect(host.textContent).not.toContain('Something went wrong');
    unmount();
  });
});

describe('QueueControl mutation races and response semantics', () => {
  test('double-click submits once and malformed action success is rejected', async () => {
    const pause = deferred<Response>();
    let pauseCalls = 0;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/dashboard/queues') return Promise.resolve(json(queuePage(['q-a'])));
      if (url.pathname === '/dashboard/queues/q-a') {
        return Promise.resolve(json(queueDetail('q-a')));
      }
      if (url.pathname === '/queues/summary') {
        return Promise.resolve(json([queueSummaryEntry('q-a')]));
      }
      if (url.pathname.endsWith('/stall-config')) {
        return Promise.resolve(json({ ok: true, config: stallConfig }));
      }
      if (url.pathname.endsWith('/dlq-config')) {
        return Promise.resolve(json({ ok: true, config: dlqConfig }));
      }
      if (url.pathname === '/queues/q-a/pause' && init?.method === 'POST') {
        pauseCalls += 1;
        return pause.promise;
      }
      return Promise.resolve(json({ ok: false, error: 'unexpected request' }, 500));
    }) as typeof fetch;

    const { host } = renderControl();
    await settle(35);
    const pauseButton = findButton(host, 'Pause');
    act(() => {
      pauseButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      pauseButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    await settle(2);
    expect(pauseCalls).toBe(1);

    await act(async () => {
      pause.resolve(json({}));
      await new Promise((resolve) => setTimeout(resolve, 8));
    });
    expect(host.textContent).toContain('Malformed queue action response');
    expect(host.textContent).not.toContain('Paused ✓');
  });

  test('an old queue action cannot publish success under a new selection', async () => {
    const pause = deferred<Response>();
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/dashboard/queues') {
        return Promise.resolve(json(queuePage(['q-a', 'q-b'])));
      }
      if (url.pathname === '/dashboard/queues/q-a') {
        return Promise.resolve(json(queueDetail('q-a', 1)));
      }
      if (url.pathname === '/dashboard/queues/q-b') {
        return Promise.resolve(json(queueDetail('q-b', 42)));
      }
      if (url.pathname === '/queues/summary') {
        return Promise.resolve(json([queueSummaryEntry('q-a'), queueSummaryEntry('q-b')]));
      }
      if (url.pathname.endsWith('/stall-config')) {
        return Promise.resolve(json({ ok: true, config: stallConfig }));
      }
      if (url.pathname.endsWith('/dlq-config')) {
        return Promise.resolve(json({ ok: true, config: dlqConfig }));
      }
      if (url.pathname === '/queues/q-a/pause' && init?.method === 'POST') return pause.promise;
      return Promise.resolve(json({ ok: false, error: 'unexpected request' }, 500));
    }) as typeof fetch;

    const { host } = renderControl();
    await settle(35);
    click(host, 'Pause');
    const picker = host.querySelector('[name="queue-control-queue"]') as HTMLSelectElement;
    setValue(picker, 'q-b');
    await settle(25);

    await act(async () => {
      pause.resolve(json({ ok: true }));
      await new Promise((resolve) => setTimeout(resolve, 8));
    });
    expect(picker.value).toBe('q-b');
    expect(host.textContent).toContain('42');
    expect(host.textContent).not.toContain('Paused ✓');
  });

  test('strict action result parsing accepts only the v2.8.55 success shape', () => {
    expect(actionResultCount({ ok: true })).toBeUndefined();
    expect(actionResultCount({ ok: true, count: 0 })).toBe(0);
    expect(() => actionResultCount(undefined)).toThrow('expected { ok: true }');
    expect(() => actionResultCount({ ok: true, count: -1 })).toThrow('non-negative integer');
    expect(() => actionResultCount({ ok: true, count: 1.5 })).toThrow('non-negative integer');
  });
});

describe('Queue lifecycle request scope and destructive confirmations', () => {
  test('flow-destructive queue operations fail closed without invoking run', () => {
    let calls = 0;
    const run: RunAction = () => {
      calls += 1;
    };
    const { host } = render(
      createElement(LifecycleCard, { queue: 'orders', paused: false, busy: false, run })
    );
    const clean = findButton(host, 'Clean');
    const drain = findButton(host, 'Drain');
    expect(clean.disabled).toBe(true);
    expect(drain.disabled).toBe(true);
    expect(clean.title).toContain('reverse flow dependencies');
    expect(drain.title).toBe(clean.title);
    expect((host.querySelector('[name="clean-state"]') as HTMLSelectElement).disabled).toBe(true);
    act(() => {
      clean.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      drain.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    expect(calls).toBe(0);
  });

  test('completed requeue is disabled while promotion still names its full effect and target', () => {
    let confirmation = '';
    let calls = 0;
    const run: RunAction = (_label, _fn, nextConfirmation) => {
      calls += 1;
      confirmation = nextConfirmation ?? '';
    };
    const { host } = render(
      createElement(LifecycleCard, { queue: 'orders', paused: false, busy: false, run })
    );

    const requeue = findButton(host, 'Requeue completed');
    expect(requeue.disabled).toBe(true);
    act(() => requeue.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    expect(calls).toBe(0);
    expect(confirmation).toBe('');

    click(host, 'Promote delayed');
    expect(calls).toBe(1);
    expect(confirmation).toContain('every delayed job');
    expect(promoteConfirmation('orders', 3)).toContain('up to 3 delayed jobs');
  });

  test('rate-limit and concurrency controls send exact v2.8.55 bodies and methods', async () => {
    const calls: Array<{ path: string; method: string; body: unknown }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        path: new URL(String(input)).pathname,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return json({ ok: true });
    }) as typeof fetch;

    const rate = rateLimitArgs('10', '60000', '3600000');
    const concurrency = concurrencyArgs('4');
    expect(rate.valid).toBe(true);
    expect(concurrency.valid).toBe(true);
    await bq.setRateLimit('orders', rate.limit, rate.duration, rate.ttl);
    await bq.setConcurrency('orders', concurrency.value);
    await bq.clearRateLimit('orders');
    await bq.clearConcurrency('orders');

    expect(calls).toEqual([
      {
        path: '/queues/orders/rate-limit',
        method: 'PUT',
        body: { limit: 10, duration: 60_000, ttl: 3_600_000 },
      },
      {
        path: '/queues/orders/concurrency',
        method: 'PUT',
        body: { concurrency: 4 },
      },
      { path: '/queues/orders/rate-limit', method: 'DELETE', body: undefined },
      { path: '/queues/orders/concurrency', method: 'DELETE', body: undefined },
    ]);
  });
});

describe('Queue config validation and save lifecycle', () => {
  test('mutable policy payloads normalize integers and omit DLQ retention', () => {
    expect(
      stallConfigPayload({ enabled: false, stallInterval: '0', maxStalls: '0', gracePeriod: '0' })
    ).toEqual({
      ok: true,
      value: { enabled: false, stallInterval: 0, maxStalls: 0, gracePeriod: 0 },
    });
    expect(
      stallConfigPayload({ enabled: true, stallInterval: '1.5', maxStalls: 3, gracePeriod: 0 }).ok
    ).toBe(false);
    expect(
      stallConfigPayload({ enabled: true, stallInterval: -1, maxStalls: 3, gracePeriod: 0 }).ok
    ).toBe(false);

    expect(
      dlqConfigMutationPayload({
        autoRetry: false,
        autoRetryInterval: '0',
        maxAutoRetries: '0',
        maxAge: -1,
        maxEntries: 0,
      })
    ).toEqual({
      ok: true,
      value: {
        autoRetry: false,
        autoRetryInterval: 0,
        maxAutoRetries: 0,
      },
    });
    expect(
      dlqConfigMutationPayload({
        autoRetry: false,
        autoRetryInterval: -1,
        maxAutoRetries: 1,
        maxAge: null,
        maxEntries: 1,
      }).ok
    ).toBe(false);
    expect(
      dlqConfigMutationPayload({
        autoRetry: false,
        autoRetryInterval: 1,
        maxAutoRetries: 1.5,
        maxAge: null,
        maxEntries: 1,
      }).ok
    ).toBe(false);
  });

  test('double-click saves once and an unmounted old queue cannot report success', async () => {
    const response = deferred<Response>();
    let calls = 0;
    let saved = 0;
    globalThis.fetch = (() => {
      calls += 1;
      return response.promise;
    }) as typeof fetch;

    const { host, unmount } = render(
      createElement(StallForm, {
        queue: 'q-a',
        config: stallConfig,
        onSaved: () => {
          saved += 1;
        },
      })
    );
    const saveButton = findButton(host, 'Save');
    act(() => {
      saveButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      saveButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    expect(calls).toBe(1);
    unmount();

    await act(async () => {
      response.resolve(json({ ok: true }));
      await new Promise((resolve) => setTimeout(resolve, 8));
    });
    expect(saved).toBe(0);
  });

  test('a same-name server retarget invalidates the old config save and unlocks the new one', async () => {
    const oldResponse = deferred<Response>();
    const calls: Array<{ url: string; auth: string | null }> = [];
    let saved = 0;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        auth: new Headers(init?.headers).get('Authorization'),
      });
      return calls.length === 1 ? oldResponse.promise : Promise.resolve(json({ ok: true }));
    }) as typeof fetch;

    const { host } = render(
      createElement(StallForm, {
        queue: 'shared-name',
        config: stallConfig,
        onSaved: () => {
          saved += 1;
        },
      })
    );
    click(host, 'Save');
    expect(calls).toEqual([
      { url: 'http://server.test/queues/shared-name/stall-config', auth: null },
    ]);

    act(() => {
      useConnectionStore.setState({ baseUrl: 'http://server-b.test', token: 'token-b' });
    });
    await settle(5);
    oldResponse.resolve(json({}));
    await settle(10);
    expect(saved).toBe(0);
    expect(host.textContent).not.toContain('Saved ✓');
    expect(host.textContent).not.toContain('Malformed /stall-config response');
    expect(findButton(host, 'Save').disabled).toBeFalse();

    click(host, 'Save');
    await settle(10);
    expect(calls[1]).toEqual({
      url: 'http://server-b.test/queues/shared-name/stall-config',
      auth: 'Bearer token-b',
    });
    expect(saved).toBe(1);
    expect(host.textContent).toContain('Saved ✓');
  });

  test('an A→B→A batch cannot revive or keep a stale stall-config save locked', async () => {
    useConnectionStore.setState({ baseUrl: 'http://server-a.test', token: 'token-a' });
    const oldResponse = deferred<Response>();
    const calls: Array<{ url: string; auth: string | null }> = [];
    let saved = 0;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        auth: new Headers(init?.headers).get('Authorization'),
      });
      return calls.length === 1 ? oldResponse.promise : Promise.resolve(json({ ok: true }));
    }) as typeof fetch;
    const { host } = render(
      createElement(StallForm, {
        queue: 'shared-name',
        config: stallConfig,
        onSaved: () => {
          saved += 1;
        },
      })
    );

    click(host, 'Save');
    act(() => {
      useConnectionStore.setState({ baseUrl: 'http://server-b.test', token: 'token-b' });
      useConnectionStore.setState({ baseUrl: 'http://server-a.test', token: 'token-a' });
    });
    await settle(5);
    expect(findButton(host, 'Save').disabled).toBeFalse();

    click(host, 'Save');
    await settle(10);
    expect(calls).toEqual([
      {
        url: 'http://server-a.test/queues/shared-name/stall-config',
        auth: 'Bearer token-a',
      },
      {
        url: 'http://server-a.test/queues/shared-name/stall-config',
        auth: 'Bearer token-a',
      },
    ]);
    expect(saved).toBe(1);
    expect(host.textContent).toContain('Saved ✓');

    oldResponse.resolve(json({}));
    await settle(10);
    expect(saved).toBe(1);
    expect(host.textContent).toContain('Saved ✓');
    expect(host.textContent).not.toContain('Malformed /stall-config response');
  });

  test('an A→B→A batch cannot revive or keep a stale DLQ-config save locked', async () => {
    useConnectionStore.setState({ baseUrl: 'http://server-a.test', token: 'token-a' });
    const oldResponse = deferred<Response>();
    const calls: Array<{ url: string; auth: string | null }> = [];
    let saved = 0;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        auth: new Headers(init?.headers).get('Authorization'),
      });
      return calls.length === 1 ? oldResponse.promise : Promise.resolve(json({ ok: true }));
    }) as typeof fetch;
    const { host } = render(
      createElement(DlqConfigForm, {
        queue: 'shared-name',
        config: dlqConfig,
        onSaved: () => {
          saved += 1;
        },
      })
    );

    click(host, 'Save');
    act(() => {
      useConnectionStore.setState({ baseUrl: 'http://server-b.test', token: 'token-b' });
      useConnectionStore.setState({ baseUrl: 'http://server-a.test', token: 'token-a' });
    });
    await settle(5);
    expect(findButton(host, 'Save').disabled).toBeFalse();

    click(host, 'Save');
    await settle(10);
    expect(calls).toEqual([
      {
        url: 'http://server-a.test/queues/shared-name/dlq-config',
        auth: 'Bearer token-a',
      },
      {
        url: 'http://server-a.test/queues/shared-name/dlq-config',
        auth: 'Bearer token-a',
      },
    ]);
    expect(saved).toBe(1);
    expect(host.textContent).toContain('Saved ✓');

    oldResponse.resolve(json({}));
    await settle(10);
    expect(saved).toBe(1);
    expect(host.textContent).toContain('Saved ✓');
    expect(host.textContent).not.toContain('Malformed /dlq-config response');
  });

  test('save completion remains live through the StrictMode effect probe', async () => {
    let calls = 0;
    let saved = 0;
    globalThis.fetch = (() => {
      calls += 1;
      return Promise.resolve(json({ ok: true }));
    }) as typeof fetch;

    const { host } = render(
      createElement(
        StrictMode,
        null,
        createElement(StallForm, {
          queue: 'q-a',
          config: stallConfig,
          onSaved: () => {
            saved += 1;
          },
        })
      )
    );
    click(host, 'Save');
    await settle(12);
    expect(calls).toBe(1);
    expect(saved).toBe(1);
    expect(host.textContent).toContain('Saved ✓');
  });

  test('a malformed config mutation response is shown as an error, never Saved', async () => {
    globalThis.fetch = (() => Promise.resolve(json({}))) as typeof fetch;
    const { host } = render(
      createElement(StallForm, { queue: 'q-a', config: stallConfig, onSaved: () => undefined })
    );
    click(host, 'Save');
    await settle(12);
    expect(host.textContent).toContain('Malformed /stall-config response');
    expect(host.textContent).not.toContain('Saved ✓');
  });

  test('DLQ auto-retry can only be disabled, never enabled', async () => {
    const disabledView = render(
      createElement(DlqConfigForm, {
        queue: 'q-a',
        config: dlqConfig,
        onSaved: () => undefined,
      })
    );
    const disabledToggle = disabledView.host.querySelector<HTMLButtonElement>(
      '[role="switch"][aria-label="auto-retry"]'
    );
    expect(disabledToggle?.disabled).toBe(true);
    const retentionInputs = [
      ...disabledView.host.querySelectorAll<HTMLInputElement>('input[type="number"]'),
    ].filter((input) => input.value === '604800000' || input.value === '10000');
    expect(retentionInputs).toHaveLength(2);
    for (const input of retentionInputs) {
      expect(input.disabled).toBe(true);
      expect(input.readOnly).toBe(true);
      expect(input.title).toContain('read-only');
    }
    disabledView.unmount();

    let body: unknown;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = init?.body ? JSON.parse(String(init.body)) : undefined;
      return json({ ok: true });
    }) as typeof fetch;
    const enabledView = render(
      createElement(DlqConfigForm, {
        queue: 'q-a',
        config: { ...dlqConfig, autoRetry: true },
        onSaved: () => undefined,
      })
    );
    const enabledToggle = enabledView.host.querySelector<HTMLButtonElement>(
      '[role="switch"][aria-label="auto-retry"]'
    );
    expect(enabledToggle?.disabled).toBe(false);
    act(() => enabledToggle?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    click(enabledView.host, 'Save');
    await settle(10);
    expect(body).toEqual({
      config: {
        autoRetry: false,
        autoRetryInterval: 3_600_000,
        maxAutoRetries: 3,
      },
    });
    expect((body as { config: Record<string, unknown> }).config).not.toHaveProperty('maxAge');
    expect((body as { config: Record<string, unknown> }).config).not.toHaveProperty('maxEntries');
  });
});
