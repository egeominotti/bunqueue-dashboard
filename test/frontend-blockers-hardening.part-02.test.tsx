import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import {
  AddJob,
  MAX_JOB_DATA_CHARS,
  parseJobData,
  utf8ByteLength,
} from '../src/pages/control/AddJob';
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

function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
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

function _selectFile(input: HTMLInputElement, file: Pick<File, 'name' | 'size'>): void {
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

describe('bounded job-data parsing', () => {
  test('counts UTF-8 correctly and never enters JSON.parse on oversize blur or submit', async () => {
    expect(utf8ByteLength('Aé💥')).toBe(7);
    expect(parseJobData('{"emoji":"💥"}').ok).toBe(true);
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/dashboard/queues')) {
        return Promise.resolve(json(queuePage([], 0, 0)));
      }
      return Promise.resolve(json({ ok: false, error: `unexpected ${url}` }, 500));
    }) as typeof fetch;

    const view = render(createElement(MemoryRouter, {}, createElement(AddJob)));
    await settle(5);
    const queue = view.host.querySelector<HTMLInputElement>('[name="target-queue"]')!;
    const textarea = view.host.querySelector<HTMLTextAreaElement>('[name="job-data"]')!;
    expect(textarea.maxLength).toBe(MAX_JOB_DATA_CHARS);
    setValue(queue, 'orders');
    setValue(textarea, 'x'.repeat(MAX_JOB_DATA_CHARS + 1));

    let parseCalls = 0;
    Object.defineProperty(JSON, 'parse', {
      configurable: true,
      writable: true,
      value: ((...args: Parameters<typeof JSON.parse>) => {
        parseCalls += 1;
        return realJsonParse(...args);
      }) as typeof JSON.parse,
    });

    const utf8Oversize = `"${'💥'.repeat(MAX_JOB_DATA_CHARS / 4 + 1)}"`;
    expect(utf8Oversize.length).toBeLessThan(MAX_JOB_DATA_CHARS);
    expect(parseJobData(utf8Oversize).ok).toBe(false);
    expect(parseCalls).toBe(0);

    act(() => {
      const props = reactProps<{ onBlur?: () => void }>(textarea);
      if (!props.onBlur) throw new Error('Job data textarea has no onBlur');
      props.onBlur();
    });
    expect(parseCalls).toBe(0);
    expect(view.host.textContent).toContain('Job data is too large');

    act(() => {
      view.host
        .querySelector('form')!
        .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(parseCalls).toBe(0);
    expect(view.host.textContent).toContain('Job data is too large');
  });

  test('Add Job rejects data x count above the aggregate transport budget', async () => {
    let bulkCalls = 0;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/dashboard/queues')) {
        return Promise.resolve(json(queuePage(['orders'], 1, 0)));
      }
      if (url.includes('/jobs/bulk')) bulkCalls += 1;
      return Promise.resolve(json({ ok: true, ids: [] }));
    }) as typeof fetch;

    const view = render(createElement(MemoryRouter, {}, createElement(AddJob)));
    await settle(5);
    setValue(view.host.querySelector<HTMLInputElement>('[name="target-queue"]')!, 'orders');
    setValue(
      view.host.querySelector<HTMLTextAreaElement>('[name="job-data"]')!,
      JSON.stringify({ blob: 'x'.repeat(1024 * 1024) })
    );
    setValue(view.host.querySelector<HTMLInputElement>('[name="count"]')!, '100');

    act(() => {
      view.host
        .querySelector('form')!
        .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    });
    await settle(5);

    expect(view.host.textContent).toContain('64 MiB UTF-8 safety limit');
    expect(bulkCalls).toBe(0);
  });
});
