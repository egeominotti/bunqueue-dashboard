import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { QueueOperationsRepository } from '../src/features/queue-operations/application/QueueOperationsRepository';
import { QueueOperationsPanel } from '../src/features/queue-operations/ui/QueueOperationsPanel';
import { ensureDom, settle } from './domSetup';

const mounted = new Set<() => void>();
let originalConfirm: typeof window.confirm;

beforeEach(() => {
  ensureDom();
  originalConfirm = window.confirm;
  window.confirm = () => true;
});

afterEach(() => {
  for (const unmount of [...mounted]) unmount();
  window.confirm = originalConfirm;
});

describe('Queue SDK operations UI', () => {
  test('operates all read and mutation surfaces with explicit queue scope', async () => {
    const calls: string[] = [];
    let applied = 0;
    const repository = repositoryOf(calls);
    const { host } = render(
      createElement(QueueOperationsPanel, {
        queue: 'orders',
        repository,
        onApplied: () => {
          applied += 1;
        },
      })
    );
    await settle(10);
    expect(host.textContent).toContain('12 / 1000 ms');
    expect(host.textContent).toContain('Global concurrency');
    expect(host.textContent).toContain('Available');

    setValue(input(host, 'queue-sdk-deduplication-id'), 'invoice:7');
    click(host, 'Find owner');
    await settle(5);
    expect(host.textContent).toContain('Current job: job-42');

    click(host, 'Remove key');
    await settle(5);
    expect(host.textContent).toContain('Deduplication key removed');

    click(host, 'Read metrics');
    await settle(5);
    expect(host.textContent).toContain('Total terminal: 9');
    expect(host.querySelector('[role="img"]')?.getAttribute('aria-label')).toContain(
      'one-minute metric buckets'
    );

    click(host, 'Trim journal');
    await settle(5);
    expect(host.textContent).toContain('3 lifecycle events removed');
    expect(applied).toBe(2);
    expect(calls).toContain('limits:orders:undefined');
    expect(calls).toContain('dedup:orders:invoice:7');
    expect(calls).toContain('remove:orders:invoice:7');
    expect(calls).toContain('metrics:orders:completed:0:29');
    expect(calls).toContain('trim:orders:1000');
  });

  test('same-tick duplicate actions are suppressed by the shared UI mutex', async () => {
    let resolve!: (value: string | null) => void;
    let lookups = 0;
    const base = repositoryOf([]);
    const repository: QueueOperationsRepository = {
      ...base,
      deduplicationJobId: () => {
        lookups += 1;
        return new Promise((done) => {
          resolve = done;
        });
      },
    };
    const { host } = render(createElement(QueueOperationsPanel, { queue: 'orders', repository }));
    await settle(10);
    setValue(input(host, 'queue-sdk-deduplication-id'), 'same-key');
    act(() => {
      button(host, 'Find owner').click();
      button(host, 'Find owner').click();
    });
    expect(lookups).toBe(1);
    await act(async () => {
      resolve('job-one');
      await Promise.resolve();
    });
    expect(host.textContent).toContain('job-one');
  });

  test('clears queue-scoped snapshots and receipts synchronously when retargeted', async () => {
    type Limits = Awaited<ReturnType<QueueOperationsRepository['limits']>>;
    let resolveInvoices!: (value: Limits) => void;
    const base = repositoryOf([]);
    const repository: QueueOperationsRepository = {
      ...base,
      limits: (queue) =>
        queue === 'orders'
          ? base.limits(queue)
          : new Promise<Limits>((resolve) => {
              resolveInvoices = resolve;
            }),
    };
    const view = render(createElement(QueueOperationsPanel, { queue: 'orders', repository }));
    await settle(10);
    setValue(input(view.host, 'queue-sdk-deduplication-id'), 'invoice:7');
    click(view.host, 'Find owner');
    await settle(5);
    click(view.host, 'Remove key');
    await settle(5);
    click(view.host, 'Read metrics');
    await settle(5);
    click(view.host, 'Trim journal');
    await settle(5);
    expect(view.host.textContent).toContain('12 / 1000 ms');
    expect(view.host.textContent).toContain('Deduplication key removed');
    expect(view.host.textContent).toContain('Total terminal: 9');
    expect(view.host.textContent).toContain('3 lifecycle events removed');

    view.rerender(createElement(QueueOperationsPanel, { queue: 'invoices', repository }));
    expect(view.host.textContent).not.toContain('12 / 1000 ms');
    expect(view.host.textContent).not.toContain('Deduplication key removed');
    expect(view.host.textContent).not.toContain('Total terminal: 9');
    expect(view.host.textContent).not.toContain('3 lifecycle events removed');

    await act(async () => {
      resolveInvoices({
        rateLimit: { max: 2, duration: 500 },
        concurrency: 1,
        rateLimitTtl: 0,
        maxed: false,
      });
      await Promise.resolve();
    });
    expect(view.host.textContent).toContain('2 / 500 ms');
  });
});

function repositoryOf(calls: string[]): QueueOperationsRepository {
  return {
    limits: async (queue, maxJobs) => {
      calls.push(`limits:${queue}:${maxJobs}`);
      return {
        rateLimit: { max: 12, duration: 1000 },
        concurrency: 5,
        rateLimitTtl: 0,
        maxed: false,
      };
    },
    deduplicationJobId: async (queue, id) => {
      calls.push(`dedup:${queue}:${id}`);
      return 'job-42';
    },
    removeDeduplicationKey: async (queue, id) => {
      calls.push(`remove:${queue}:${id}`);
      return 1;
    },
    metrics: async (queue, type, start, end) => {
      calls.push(`metrics:${queue}:${type}:${start}:${end}`);
      return { meta: { count: 9, prevTS: 100, prevCount: 2 }, data: [2, 1, 0], count: 3 };
    },
    trimEvents: async (queue, maxLength) => {
      calls.push(`trim:${queue}:${maxLength}`);
      return 3;
    },
  };
}

function render(element: ReturnType<typeof createElement>) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(element));
  const unmount = () => {
    if (!mounted.delete(unmount)) return;
    act(() => root.unmount());
    host.remove();
  };
  mounted.add(unmount);
  return {
    host,
    unmount,
    rerender: (next: ReturnType<typeof createElement>) => act(() => root.render(next)),
  };
}

function input(host: HTMLElement, name: string): HTMLInputElement {
  const found = host.querySelector(`[name="${name}"]`);
  if (!(found instanceof window.HTMLInputElement)) throw new Error(`Missing input ${name}`);
  return found;
}

function setValue(element: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(
      element,
      value
    );
    const propsKey = Object.getOwnPropertyNames(element).find((key) =>
      key.startsWith('__reactProps$')
    );
    const props = propsKey
      ? ((element as unknown as Record<string, unknown>)[propsKey] as {
          onChange?: (event: { target: HTMLInputElement; currentTarget: HTMLInputElement }) => void;
        })
      : null;
    if (!props?.onChange) throw new Error('Controlled input has no React onChange handler');
    props.onChange({ target: element, currentTarget: element });
  });
}

function button(host: HTMLElement, text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((entry) =>
    entry.textContent?.includes(text)
  );
  if (!found) throw new Error(`Missing button ${text}`);
  return found;
}

function click(host: HTMLElement, text: string): void {
  act(() => button(host, text).click());
}
