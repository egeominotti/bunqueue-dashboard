import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { FlowOperationsRepository } from '../src/features/flows/application/FlowOperationsRepository';

type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

export function renderFlowUi(element: ReactElement) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(element));
  return {
    host,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

export function changeControl(control: Control, value: string): void {
  act(() => {
    const prototype = Object.getPrototypeOf(control) as object;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(control, value);
    const propsKey = Object.getOwnPropertyNames(control).find((key) =>
      key.startsWith('__reactProps$')
    );
    const props = propsKey
      ? ((control as unknown as Record<string, unknown>)[propsKey] as {
          onChange?: (event: { target: Control }) => void;
        })
      : undefined;
    if (props?.onChange) {
      props.onChange({ target: control });
      return;
    }
    control.dispatchEvent(new window.Event('input', { bubbles: true }));
    control.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}

export function button(host: HTMLElement, label: string): HTMLButtonElement {
  const match = Array.from(host.querySelectorAll('button')).find(
    (candidate) => candidate.textContent === label
  );
  if (!match) throw new Error(`Missing button ${label}`);
  return match;
}

export function field<T extends Control>(host: HTMLElement, label: string, index = 0): T {
  const match = host.querySelectorAll(`[aria-label="${label}"]`).item(index);
  if (!isControl(match)) throw new Error(`Missing field ${label} at index ${index}`);
  return match as T;
}

export function submit(host: HTMLElement): void {
  const form = host.querySelector('form');
  if (!form) throw new Error('Missing form');
  act(() => form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
}

export function click(control: HTMLButtonElement): void {
  act(() => control.click());
}

export function fakeRepository(
  overrides: Partial<FlowOperationsRepository>
): FlowOperationsRepository {
  return {
    create: async () => ({}),
    getFlow: async () => ({}),
    getParentResult: async () => ({}),
    getParentResults: async () => ({}),
    inspect: async () => ({}),
    mutate: async () => ({}),
    waitUntilFinished: async () => ({}),
    ...overrides,
  };
}

export function marker(value: string): Record<string, unknown> {
  return { marker: value };
}

export { createElement };

function isControl(value: Element | null): value is Control {
  return (
    value instanceof window.HTMLInputElement ||
    value instanceof window.HTMLSelectElement ||
    value instanceof window.HTMLTextAreaElement
  );
}
