import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { Dlq, discoverAllDlqQueues } from '../src/pages/Dlq';
import { discoverAllLogQueues, Logs } from '../src/pages/Logs';
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

describe('classic DLQ and Logs queue discovery', () => {
  test('both dropdowns include queues beyond the first 500', async () => {
    const offsets: number[] = [];
    const names = Array.from({ length: 501 }, (_, index) => `q${index}`);
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/dashboard/queues')) {
        const offset = Number(url.searchParams.get('offset'));
        offsets.push(offset);
        const pageNames = offset === 0 ? names.slice(0, 500) : names.slice(500);
        return Promise.resolve(json(queuePage(pageNames, names.length, offset, 'q500')));
      }
      if (url.pathname.includes('/queues/q500/dlq')) {
        return Promise.resolve(json({ ok: true, entries: [], total: 0 }));
      }
      return Promise.resolve(json({ ok: false, error: 'stream unavailable' }, 503));
    }) as typeof fetch;

    const dlq = render(createElement(Dlq));
    await settle(25);
    const dlqSelect = dlq.host.querySelector<HTMLSelectElement>('[name="classic-dlq-queue"]')!;
    expect([...dlqSelect.options].some((option) => option.value === 'q500')).toBe(true);
    expect(dlqSelect.value).toBe('q500');
    dlq.unmount();

    const logs = render(createElement(Logs));
    await settle(25);
    const logSelect = logs.host.querySelector<HTMLSelectElement>(
      '[name="classic-activity-queue-filter"]'
    )!;
    expect([...logSelect.options].some((option) => option.value === 'q500')).toBe(true);
    logs.unmount();
    expect(offsets.filter((offset) => offset === 500).length).toBeGreaterThanOrEqual(2);
  });

  test('moving, malformed, and hostile snapshots fail closed within the page bound', async () => {
    let calls = 0;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const offset = Number(new URL(String(input)).searchParams.get('offset'));
      calls += 1;
      const names =
        offset === 0 ? Array.from({ length: 500 }, (_, index) => `q${index}`) : ['q500', 'q501'];
      return Promise.resolve(json(queuePage(names, offset === 0 ? 501 : 502, offset)));
    }) as typeof fetch;
    await expect(discoverAllDlqQueues()).rejects.toThrow('malformed or unsafe page');
    expect(calls).toBe(2);

    globalThis.fetch = (() =>
      Promise.resolve(
        json({
          ...queuePage(['valid-name'], 1, 0),
          queues: [{ ...queueRow('valid-name'), dlq: 'many' }],
        })
      )) as typeof fetch;
    await expect(discoverAllLogQueues()).rejects.toThrow('malformed queue summaries');

    calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      return Promise.resolve(json(queuePage([], 10_001, 0)));
    }) as typeof fetch;
    await expect(discoverAllLogQueues()).rejects.toThrow('malformed or unsafe page');
    expect(calls).toBe(1);
  });
});
