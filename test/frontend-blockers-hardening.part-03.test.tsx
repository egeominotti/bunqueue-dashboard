import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import {
  BulkAddJobs,
  bulkPayloadBudgetError,
  MAX_BULK_INPUT_BYTES,
  MAX_BULK_INPUT_CHARS,
} from '../src/pages/control/BulkAddJobs';
import { ensureDom, settle } from './domSetup';

ensureDom();

const realFetch = globalThis.fetch;
const realConfirm = window.confirm;
const realFileReader = globalThis.FileReader;
const realWindowFileReader = window.FileReader;
const realJsonParse = JSON.parse;
const mounted = new Set<() => void>();

const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'content-type': 'application/json' } });

function _deferred<T>() {
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

function reactProps<T extends object>(element: Element): T {
  const key = Object.getOwnPropertyNames(element).find((name) => name.startsWith('__reactProps$'));
  if (!key) throw new Error('React props were not installed on the test control');
  return (element as unknown as Record<string, unknown>)[key] as T;
}

function _setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  act(() => {
    const prototype =
      element.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
    const props = reactProps<{
      onChange?: (event: { target: typeof element; currentTarget: typeof element }) => void;
    }>(element);
    if (!props.onChange) throw new Error('Controlled input has no onChange');
    props.onChange({ target: element, currentTarget: element });
  });
}

function _clickButton(host: ParentNode, label: string): void {
  const button = [...host.querySelectorAll('button')].find((candidate) =>
    (candidate.textContent ?? '').includes(label)
  );
  if (!button) throw new Error(`No button containing "${label}"`);
  act(() => button.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
}

const queueRow = (name: string, dlq = 0) => ({
  name,
  waiting: 0,
  delayed: 0,
  active: 0,
  dlq,
  paused: false,
});

const queuePage = (names: string[], total: number, offset: number, dlqName?: string) => ({
  ok: true,
  queues: names.map((name) => queueRow(name, name === dlqName ? 1 : 0)),
  total,
  limit: 500,
  offset,
  timestamp: 1,
});

const _benchmarkCounts = (waiting = 0) => ({
  waiting,
  prioritized: 0,
  delayed: 0,
  active: 0,
  paused: 0,
  'waiting-children': 0,
  completed: 0,
  failed: 0,
});

class ControlledFileReader {
  static instances: ControlledFileReader[] = [];

  result: string | ArrayBuffer | null = null;
  error: DOMException | null = null;
  abortCount = 0;
  readCount = 0;
  onload: ((event: ProgressEvent<FileReader>) => void) | null = null;
  onerror: ((event: ProgressEvent<FileReader>) => void) | null = null;
  onabort: ((event: ProgressEvent<FileReader>) => void) | null = null;

  constructor() {
    ControlledFileReader.instances.push(this);
  }

  readAsText(): void {
    this.readCount += 1;
  }

  abort(): void {
    this.abortCount += 1;
    this.onabort?.(new window.Event('abort') as unknown as ProgressEvent<FileReader>);
  }

  resolve(text: string): void {
    this.result = text;
    this.onload?.(new window.Event('load') as unknown as ProgressEvent<FileReader>);
  }
}

function selectFile(input: HTMLInputElement, file: Pick<File, 'name' | 'size'>): void {
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  act(() => {
    const props = reactProps<{
      onChange?: (event: { target: HTMLInputElement; currentTarget: HTMLInputElement }) => void;
    }>(input);
    if (!props.onChange) throw new Error('File input has no onChange');
    props.onChange({ target: input, currentTarget: input });
  });
}

beforeEach(() => {
  useConnectionStore.setState({
    baseUrl: 'http://server-a.test',
    token: 'alpha',
    agentToken: 'agent-alpha',
    refreshMs: 3000,
  });
  ControlledFileReader.instances = [];
});

afterEach(() => {
  for (const unmount of [...mounted]) unmount();
  globalThis.fetch = realFetch;
  globalThis.window.confirm = realConfirm;
  globalThis.FileReader = realFileReader;
  window.FileReader = realWindowFileReader;
  Object.defineProperty(JSON, 'parse', {
    configurable: true,
    writable: true,
    value: realJsonParse,
  });
  useConnectionStore.setState({
    baseUrl: '/api',
    token: '',
    agentToken: '',
    refreshMs: 3000,
  });
});

describe('BulkAddJobs file and payload bounds', () => {
  test('is last-selection-wins, rejects size before read, and aborts on unmount', async () => {
    globalThis.FileReader = ControlledFileReader as unknown as typeof FileReader;
    window.FileReader = ControlledFileReader as unknown as typeof FileReader;
    globalThis.window.confirm = () => true;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/dashboard/queues')) {
        return Promise.resolve(json(queuePage([], 0, 0)));
      }
      return Promise.resolve(json({ ok: false, error: `unexpected ${url}` }, 500));
    }) as typeof fetch;

    const view = render(createElement(BulkAddJobs));
    await settle(5);
    const input = view.host.querySelector<HTMLInputElement>('[name="jobs-file"]')!;
    const textarea = view.host.querySelector<HTMLTextAreaElement>('[name="jobs-json"]')!;
    expect(textarea.maxLength).toBe(MAX_BULK_INPUT_CHARS);

    selectFile(input, { name: 'a.json', size: 10 });
    const readerA = ControlledFileReader.instances[0];
    selectFile(input, { name: 'b.json', size: 10 });
    const readerB = ControlledFileReader.instances[1];
    expect(readerA.abortCount).toBe(1);

    act(() => readerB.resolve('[{"data":{"source":"B"}}]'));
    act(() => readerA.resolve('[{"data":{"source":"A"}}]'));
    expect(textarea.value).toBe('[{"data":{"source":"B"}}]');

    const readerCount = ControlledFileReader.instances.length;
    selectFile(input, { name: 'huge.json', size: MAX_BULK_INPUT_BYTES + 1 });
    expect(ControlledFileReader.instances).toHaveLength(readerCount);
    expect(view.host.textContent).toContain('File is too large');

    selectFile(input, { name: 'pending.json', size: 10 });
    const pending = ControlledFileReader.instances.at(-1)!;
    expect(pending.readCount).toBe(1);
    view.unmount();
    expect(pending.abortCount).toBe(1);
  });

  test('measures the complete UTF-8 transport envelope, including jobId translation', () => {
    const bodies = [{ data: '💥', jobId: 'stable-id' }];
    expect(bulkPayloadBudgetError(bodies, 20)).toContain('payload exceeds');
    expect(bulkPayloadBudgetError(bodies, 200)).toBeNull();
  });
});
