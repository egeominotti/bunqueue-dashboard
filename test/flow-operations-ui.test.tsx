import { afterEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { FlowOperationsRepository } from '../src/features/flows/application/FlowOperationsRepository';
import { createdRootId, FlowCreator } from '../src/features/flows/ui/FlowCreator';
import { FlowDependencyConsole } from '../src/features/flows/ui/FlowDependencyConsole';
import { FlowJobToolkit } from '../src/features/flows/ui/FlowJobToolkit';
import { FlowParentResults } from '../src/features/flows/ui/FlowParentResults';
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
  return { host, unmount };
}

function input(element: HTMLInputElement | HTMLSelectElement, value: string) {
  act(() => {
    const prototype =
      element instanceof window.HTMLSelectElement
        ? window.HTMLSelectElement.prototype
        : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
    if (element instanceof window.HTMLSelectElement) {
      element.dispatchEvent(new window.Event('change', { bubbles: true }));
    } else {
      element.dispatchEvent(new window.Event('input', { bubbles: true }));
      element.dispatchEvent(new window.Event('change', { bubbles: true }));
    }
  });
}

afterEach(() => {
  for (const unmount of mounted) unmount();
  mounted.clear();
});

describe('FlowProducer operation UI', () => {
  test('recognizes a browsable result from every create contract', () => {
    expect(createdRootId({ result: { root: { id: 'add' } } })).toBe('add');
    expect(createdRootId({ result: { roots: [{ id: 'bulk' }] } })).toBe('bulk');
    expect(createdRootId({ result: { jobIds: ['first', 'chain-final'] } })).toBe('chain-final');
    expect(createdRootId({ result: { finalId: 'bulk-then-final' } })).toBe('bulk-then-final');
    expect(createdRootId({ result: {} })).toBeNull();
  });

  test('submits all five creation modes and synchronously rejects a double submit', async () => {
    const operations: string[] = [];
    let release: (() => void) | undefined;
    const repository = fakeRepository({
      create: (operation) => {
        operations.push(operation);
        return new Promise((resolve) => {
          release = () => resolve({ ok: true });
        });
      },
    });
    const { host } = render(createElement(FlowCreator, { repository, onOpen: () => undefined }));
    const select = host.querySelector('select');
    const form = host.querySelector('form');
    if (!select || !form) throw new Error('Creator controls missing');
    for (const operation of ['add', 'addBulk', 'addChain', 'addBulkThen', 'addTree']) {
      input(select, operation);
      act(() => {
        form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
        form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      });
      expect(operations.at(-1)).toBe(operation);
      expect(operations.filter((item) => item === operation)).toHaveLength(1);
      release?.();
      await settle(2);
    }
  });

  test('wires every dependency inspection and mutation to the selected target', async () => {
    const calls: string[] = [];
    const repository = fakeRepository({
      inspect: async (target, operation) => {
        calls.push(`read:${operation}:${target.id}:${target.queueName}`);
        return {};
      },
      mutate: async (target, operation) => {
        calls.push(`write:${operation}:${target.id}:${target.queueName}`);
        return {};
      },
    });
    const originalConfirm = window.confirm;
    window.confirm = () => true;
    try {
      const { host } = render(
        createElement(FlowDependencyConsole, {
          repository,
          initialTarget: { id: 'job-1', queueName: 'queue-a' },
        })
      );
      for (const button of host.querySelectorAll('button')) {
        act(() => button.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
        await settle(2);
      }
      expect(calls).toHaveLength(10);
      expect(calls.every((call) => call.endsWith(':job-1:queue-a'))).toBeTrue();
    } finally {
      window.confirm = originalConfirm;
    }
  });

  test('reads one or many parent results and rejects a same-tick duplicate', async () => {
    const calls: string[] = [];
    let release: (() => void) | undefined;
    const repository = fakeRepository({
      getParentResult: async (id) => {
        calls.push(`one:${id}`);
        return {};
      },
      getParentResults: (ids) => {
        calls.push(`many:${ids.join('|')}`);
        return new Promise((resolve) => {
          release = () => resolve({});
        });
      },
    });
    const { host } = render(
      createElement(FlowParentResults, { repository, initialIds: 'parent-a\nparent-b' })
    );
    const [one, many] = Array.from(host.querySelectorAll('button'));
    act(() => one.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    await settle(2);
    act(() => {
      many.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      many.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    expect(calls).toEqual(['one:parent-a', 'many:parent-a|parent-b']);
    release?.();
    await settle(2);
  });

  test('wires every safe Flow Job method exposed by the operator toolkit', async () => {
    const calls: string[] = [];
    let progressPayload: Record<string, unknown> | undefined;
    const repository = fakeRepository({
      inspect: async (_target, operation) => {
        calls.push(`inspect:${operation}`);
        return {};
      },
      mutate: async (_target, operation, payload) => {
        calls.push(`mutate:${operation}`);
        if (operation === 'updateProgress') progressPayload = payload;
        return {};
      },
      waitUntilFinished: async (_target, ttl) => {
        calls.push(`wait:${ttl}`);
        return {};
      },
    });
    const originalConfirm = window.confirm;
    window.confirm = () => true;
    try {
      const { host } = render(
        createElement(FlowJobToolkit, {
          repository,
          initialTarget: { id: 'job-1', queueName: 'queue-a' },
        })
      );
      for (const operation of [
        'getState',
        'isWaiting',
        'isActive',
        'isDelayed',
        'isCompleted',
        'isFailed',
        'isWaitingChildren',
        'toJSON',
        'asJSON',
      ]) {
        const control = Array.from(host.querySelectorAll('button')).find(
          (button) => button.textContent === operation
        );
        if (!control) throw new Error(`Missing inspection ${operation}`);
        act(() => control.click());
        await settle(2);
      }
      const select = host.querySelector('[aria-label="Flow Job mutation"]');
      const apply = Array.from(host.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Apply mutation')
      );
      if (!(select instanceof window.HTMLSelectElement) || !apply) {
        throw new Error('Missing mutation controls');
      }
      for (const operation of [
        'updateData',
        'updateProgress',
        'log',
        'changeDelay',
        'changePriority',
        'clearLogs',
        'removeDeduplicationKey',
      ]) {
        input(select, operation);
        if (operation === 'updateProgress') {
          const objectProgress = Array.from(host.querySelectorAll('button')).find(
            (button) => button.textContent === 'Object progress'
          );
          if (!objectProgress) throw new Error('Missing object progress template');
          act(() => objectProgress.click());
        }
        act(() => apply.click());
        await settle(2);
      }
      const wait = Array.from(host.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('waitUntilFinished')
      );
      if (!wait) throw new Error('Missing waitUntilFinished');
      act(() => wait.click());
      await settle(2);
      expect(calls).toEqual([
        'inspect:getState',
        'inspect:isWaiting',
        'inspect:isActive',
        'inspect:isDelayed',
        'inspect:isCompleted',
        'inspect:isFailed',
        'inspect:isWaitingChildren',
        'inspect:toJSON',
        'inspect:asJSON',
        'mutate:updateData',
        'mutate:updateProgress',
        'mutate:log',
        'mutate:changeDelay',
        'mutate:changePriority',
        'mutate:clearLogs',
        'mutate:removeDeduplicationKey',
        'wait:30000',
      ]);
      expect(progressPayload).toEqual({
        progress: { stage: 'hydrate', completed: 4, total: 10 },
      });
    } finally {
      window.confirm = originalConfirm;
    }
  });
});

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
