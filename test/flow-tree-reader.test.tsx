import { afterEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  FlowOperationsRepository,
  FlowTarget,
} from '../src/features/flows/application/FlowOperationsRepository';
import { FlowTreeReader } from '../src/features/flows/ui/FlowTreeReader';
import { ensureDom, settle } from './domSetup';

ensureDom();
const mounted = new Set<() => void>();

function render(element: ReactElement) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const unmount = () => act(() => root.unmount());
  mounted.add(unmount);
  act(() => root.render(element));
  return { host };
}

function input(element: HTMLInputElement, value: string) {
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
          onChange?: (event: { target: HTMLInputElement }) => void;
        })
      : undefined;
    if (!props?.onChange) throw new Error('Controlled input has no React onChange handler');
    props.onChange({ target: element });
  });
}

afterEach(() => {
  for (const unmount of mounted) unmount();
  mounted.clear();
});

describe('FlowProducer.getFlow operator UI', () => {
  test('rejects duplicates and discards a response after target or limit retargeting', async () => {
    const calls: Array<FlowTarget & { depth?: number; maxChildren?: number }> = [];
    let release: (() => void) | undefined;
    const repository = fakeRepository({
      getFlow: (target) => {
        calls.push(target);
        if (calls.length > 1) return Promise.resolve(treeResponse(target.id));
        return new Promise((resolve) => {
          release = () => resolve(treeResponse('root-1'));
        });
      },
    });
    const { host } = render(createElement(Harness, { repository }));
    input(requiredInput(host, 'getFlow Depth'), '4');
    input(requiredInput(host, 'getFlow Children per level'), '12');
    await settle(2);
    const load = requiredButton(host, 'Load getFlow tree');
    act(() => {
      load.click();
      load.click();
    });
    expect(calls).toEqual([{ id: 'root-1', queueName: 'orders', depth: 4, maxChildren: 12 }]);

    input(requiredInput(host, 'Flow job ID'), 'root-2');
    input(requiredInput(host, 'getFlow Depth'), '5');
    release?.();
    await settle(3);

    expect(requiredInput(host, 'Flow job ID').value).toBe('root-2');
    expect(host.textContent).not.toContain('orders/root-1');
    expect(host.querySelector('[aria-label="getFlow tree result"]')).toBeNull();

    act(() => requiredButton(host, 'Load getFlow tree').click());
    await settle(3);
    expect(calls.at(-1)).toEqual({ id: 'root-2', queueName: 'orders', depth: 5, maxChildren: 12 });
    expect(host.textContent).toContain('orders/root-2');
    expect(host.querySelector('[aria-label="getFlow tree result"]')?.textContent).toContain(
      'child-1'
    );
    expect(host.textContent).toContain('Raw getFlow JSON');
    expect(host.textContent).toContain('"children"');
  });

  test('shows request errors and blocks limits outside the agent contract', async () => {
    const repository = fakeRepository({
      getFlow: async () => {
        throw new Error('managed target changed');
      },
    });
    const { host } = render(createElement(Harness, { repository }));
    const depth = requiredInput(host, 'getFlow Depth');
    const load = requiredButton(host, 'Load getFlow tree');
    input(depth, '501');
    await settle(2);
    expect(load.disabled).toBeTrue();
    input(depth, '3');
    await settle(2);
    act(() => load.click());
    await settle(3);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('managed target changed');
  });

  test('renders the explicit not-found state returned by getFlow', async () => {
    const repository = fakeRepository({
      getFlow: async () => ({ ok: true, result: { flow: null } }),
    });
    const { host } = render(createElement(Harness, { repository }));
    act(() => requiredButton(host, 'Load getFlow tree').click());
    await settle(3);
    expect(host.textContent).toContain('Bunqueue returned no flow for this target.');
  });
});

function Harness({ repository }: { repository: FlowOperationsRepository }) {
  const [target, setTarget] = useState<FlowTarget>({ id: 'root-1', queueName: 'orders' });
  return createElement(FlowTreeReader, {
    repository,
    target,
    onTargetChange: setTarget,
  });
}

function requiredInput(host: HTMLElement, label: string): HTMLInputElement {
  const element = host.querySelector(`[aria-label="${label}"]`);
  if (!(element instanceof window.HTMLInputElement)) throw new Error(`Missing input ${label}`);
  return element;
}

function requiredButton(host: HTMLElement, label: string): HTMLButtonElement {
  const element = Array.from(host.querySelectorAll('button')).find(
    (button) => button.textContent === label
  );
  if (!element) throw new Error(`Missing button ${label}`);
  return element;
}

function fakeRepository(overrides: Partial<FlowOperationsRepository>): FlowOperationsRepository {
  return {
    create: async () => ({}),
    getFlow: async () => ({}),
    inspect: async () => ({}),
    getParentResult: async () => ({}),
    getParentResults: async () => ({}),
    waitUntilFinished: async () => ({}),
    mutate: async () => ({}),
    ...overrides,
  };
}

function treeResponse(id: string) {
  return {
    ok: true,
    result: {
      flow: {
        id,
        name: 'aggregate',
        queueName: 'orders',
        state: 'waiting-children',
        children: [
          {
            id: 'child-1',
            name: 'charge',
            queueName: 'payments',
            state: 'completed',
            children: [],
          },
        ],
      },
    },
  };
}
