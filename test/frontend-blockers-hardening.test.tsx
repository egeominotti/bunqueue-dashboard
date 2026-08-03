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
import { Benchmark } from '../src/pages/control/Benchmark';
import {
  BulkAddJobs,
  bulkPayloadBudgetError,
  MAX_BULK_INPUT_BYTES,
  MAX_BULK_INPUT_CHARS,
} from '../src/pages/control/BulkAddJobs';
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

const queuePage = (names: string[], total: number, offset: number, dlqName?: string) => ({
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
