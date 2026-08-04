import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { Benchmark } from '../src/pages/control/Benchmark';
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

function clickButton(host: ParentNode, label: string): void {
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

const _queuePage = (names: string[], total: number, offset: number, dlqName?: string) => ({
  ok: true,
  queues: names.map((name) => queueRow(name, name === dlqName ? 1 : 0)),
  total,
  limit: 500,
  offset,
  timestamp: 1,
});

const benchmarkCounts = (waiting = 0) => ({
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

describe('Benchmark telemetry target ownership', () => {
  test('keeps counts and DOM labels pinned to server A after Settings retargets to B', async () => {
    const overview = deferred<Response>();
    const calls: Array<{ url: string; auth: string | null }> = [];
    globalThis.window.confirm = () => true;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, auth: new Headers(init?.headers).get('authorization') });
      if (url === 'http://server-a.test/dashboard') return overview.promise;
      if (url.startsWith('http://server-a.test/') && url.endsWith('/counts')) {
        return Promise.resolve(json({ ok: true, counts: benchmarkCounts(7) }));
      }
      if (url.startsWith('http://server-b.test/') && url.endsWith('/counts')) {
        return Promise.resolve(json({ ok: true, counts: benchmarkCounts(999) }));
      }
      return Promise.resolve(json({ ok: false, error: `unexpected ${url}` }, 500));
    }) as typeof fetch;

    const view = render(createElement(Benchmark));
    await settle(15);
    clickButton(view.host, 'Run benchmark');
    await settle(10);
    expect(view.host.textContent).toContain('Benchmark target: http://server-a.test');

    act(() => {
      useConnectionStore.setState({ baseUrl: 'http://server-b.test', token: 'bravo' });
    });
    await settle(20);

    const compact = view.host.textContent?.replace(/\s+/g, '') ?? '';
    expect(compact).toContain('Livecountsfromhttp://server-a.test');
    expect(compact).toContain('Waiting7');
    expect(compact).not.toContain('Waiting999');
    expect(calls.some((call) => call.url.startsWith('http://server-b.test/'))).toBe(false);
    const pinnedCounts = calls.filter((call) => call.url.endsWith('/counts'));
    expect(pinnedCounts.length).toBeGreaterThanOrEqual(2);
    expect(pinnedCounts.every((call) => call.auth === 'Bearer alpha')).toBe(true);

    view.unmount();
    overview.resolve(json({ ok: true }));
    await settle(5);
  });
});
