import { afterEach, describe, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { formatNumber } from '../src/lib/format';
import { Benchmark } from '../src/pages/control/Benchmark';
import {
  benchmarkQueueError,
  DEFAULT_CONFIG,
  percentile,
} from '../src/pages/control/benchmark/engine';
import {
  assertBenchmarkSuccess,
  benchmarkQueueJobs,
  runnableQueueJobs,
  useBenchmark,
} from '../src/pages/control/benchmark/useBenchmark';
import { ensureDom, renderHook, settle } from './domSetup';

// Regression tests for the benchmark audit fixes. Each one fails against the
// pre-fix implementation.

ensureDom();

const realFetch = globalThis.fetch;
const realConfirm = globalThis.window?.confirm;

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realConfirm) globalThis.window.confirm = realConfirm;
  useConnectionStore.setState({ baseUrl: '/api', token: '' });
});

describe('engine.percentile — nearest rank', () => {
  test('empty array is 0', () => {
    expect(percentile([], 50)).toBe(0);
  });

  test('single sample is that sample for every p', () => {
    for (const p of [0, 1, 50, 95, 99, 100]) expect(percentile([42], p)).toBe(42);
  });

  test('p50 of two samples is the LOWER one (was the max before the fix)', () => {
    expect(percentile([10, 1000], 50)).toBe(10);
    expect(percentile([10, 1000], 95)).toBe(1000);
  });

  test('quartiles of [1,2,3,4]', () => {
    expect(percentile([1, 2, 3, 4], 25)).toBe(1);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4], 75)).toBe(3);
    expect(percentile([1, 2, 3, 4], 100)).toBe(4);
  });

  test('short run (Smoke preset: 4 push batches) does not collapse p50 onto the max', () => {
    const s = [5, 7, 9, 900];
    expect(percentile(s, 50)).toBe(7);
    expect(percentile(s, 95)).toBe(900);
    expect(percentile(s, 50)).not.toBe(Math.max(...s));
  });

  test('N=100: p99 is not the max, p50 is the 50th sample', () => {
    const s = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(s, 50)).toBe(50);
    expect(percentile(s, 99)).toBe(99);
    expect(percentile(s, 100)).toBe(100);
  });

  test('nearest-rank property holds for every p on a 50-sample array', () => {
    const n = 50;
    const s = Array.from({ length: n }, (_, i) => i);
    for (let p = 1; p <= 100; p++) {
      const want = s[Math.ceil((p / 100) * n) - 1];
      expect(percentile(s, p)).toBe(want);
    }
  });

  test('p=0 returns the minimum', () => {
    expect(percentile([3, 4, 5], 0)).toBe(3);
  });
});

// --- Benchmark page: Clean queue verification + Run/Clean interlock ----------

interface Rendered {
  container: HTMLElement;
  unmount: () => void;
}

function renderBenchmark(): Rendered {
  ensureDom();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(createElement(Benchmark)));
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

const buttonByText = (container: HTMLElement, text: string): HTMLButtonElement | null =>
  Array.from(container.querySelectorAll('button')).find((b) =>
    (b.textContent ?? '').includes(text)
  ) as HTMLButtonElement | null;

const click = (el: Element) => {
  act(() => {
    (el as HTMLElement).dispatchEvent(new window.Event('click', { bubbles: true }));
  });
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const benchmarkCounts = (over: Record<string, number> = {}) => ({
  waiting: 0,
  prioritized: 0,
  delayed: 0,
  active: 0,
  paused: 0,
  'waiting-children': 0,
  completed: 0,
  failed: 0,
  ...over,
});

describe('Benchmark — Clean queue verification', () => {
  test('a failed per-state clean is reported as unverified, not as "0 jobs remain"', async () => {
    useConnectionStore.setState({ baseUrl: 'http://srv', token: '' });
    globalThis.window.confirm = () => true;
    // 'waiting' clean fails; the rest succeed; counts then still shows 5000 waiting.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/clean')) {
        const state = JSON.parse(String(init?.body ?? '{}')).state as string;
        if (state === 'waiting') return json({ ok: false, error: 'clean failed: boom' });
        return json({ ok: true, count: 0 });
      }
      if (url.includes('/counts')) {
        return json({
          ok: true,
          counts: benchmarkCounts({ waiting: 5000 }),
        });
      }
      return json({ ok: true });
    }) as typeof fetch;

    const r = renderBenchmark();
    try {
      const btn = buttonByText(r.container, 'Clean queue');
      expect(btn).not.toBeNull();
      if (btn) click(btn);
      await settle(120);
      const text = r.container.textContent ?? '';
      expect(text).not.toContain('Cleaned — 0 jobs remain');
      expect(text).toContain('Clean unverified');
    } finally {
      r.unmount();
    }
  });

  test('leftover jobs after a clean that reported success are surfaced', async () => {
    useConnectionStore.setState({ baseUrl: 'http://srv', token: '' });
    globalThis.window.confirm = () => true;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/clean')) return json({ ok: true, count: 0 });
      if (url.includes('/counts')) {
        return json({
          ok: true,
          counts: benchmarkCounts({ completed: 4000 }),
        });
      }
      return json({ ok: true });
    }) as typeof fetch;

    const r = renderBenchmark();
    try {
      const btn = buttonByText(r.container, 'Clean queue');
      if (btn) click(btn);
      await settle(120);
      const text = r.container.textContent ?? '';
      expect(text).not.toContain('Cleaned — 0 jobs remain');
      expect(text).toContain(`${formatNumber(4000)} job(s) still present`);
    } finally {
      r.unmount();
    }
  });

  test('a genuinely empty queue still reports the green success', async () => {
    useConnectionStore.setState({ baseUrl: 'http://srv', token: '' });
    globalThis.window.confirm = () => true;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/clean')) return json({ ok: true, count: 12 });
      if (url.includes('/counts')) {
        return json({
          ok: true,
          counts: benchmarkCounts(),
        });
      }
      return json({ ok: true });
    }) as typeof fetch;

    const r = renderBenchmark();
    try {
      const btn = buttonByText(r.container, 'Clean queue');
      if (btn) click(btn);
      await settle(120);
      expect(r.container.textContent ?? '').toContain('Cleaned — 0 jobs remain');
    } finally {
      r.unmount();
    }
  });
});

describe('Benchmark — Run/Clean interlock', () => {
  test('Run benchmark is disabled while a clean is in flight', async () => {
    useConnectionStore.setState({ baseUrl: 'http://srv', token: '' });
    globalThis.window.confirm = () => true;
    let releaseClean: (() => void) | null = null;
    const cleanGate = new Promise<void>((resolve) => {
      releaseClean = resolve;
    });
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/clean')) {
        await cleanGate;
        return json({ ok: true, count: 0 });
      }
      if (url.includes('/counts')) {
        return json({
          ok: true,
          counts: benchmarkCounts(),
        });
      }
      return json({ ok: true });
    }) as typeof fetch;

    const r = renderBenchmark();
    try {
      const clean = buttonByText(r.container, 'Clean queue');
      if (clean) click(clean);
      await settle(30);
      const run = buttonByText(r.container, 'Run benchmark');
      expect(run).not.toBeNull();
      expect(run?.disabled).toBe(true);
      releaseClean?.();
      await settle(120);
      expect(buttonByText(r.container, 'Run benchmark')?.disabled).toBe(false);
    } finally {
      releaseClean?.();
      r.unmount();
    }
  });
});

describe('Benchmark — pre-existing job safety', () => {
  test('confirm explains that the empty-queue safety check will refuse the run', async () => {
    useConnectionStore.setState({ baseUrl: 'http://srv', token: '' });
    const prompts: string[] = [];
    globalThis.window.confirm = (msg?: string) => {
      prompts.push(String(msg));
      return false; // never actually start the load in a test
    };
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/counts')) {
        return json({
          ok: true,
          counts: benchmarkCounts({ waiting: 5000 }),
        });
      }
      return json({ ok: true });
    }) as typeof fetch;

    const r = renderBenchmark();
    try {
      // Let the debounced queue poll land so the page knows the queue depth.
      await settle(700);
      const run = buttonByText(r.container, 'Run benchmark');
      if (run) click(run);
      await settle(30);
      expect(prompts.length).toBe(1);
      expect(prompts[0]).toContain(`already holds ${formatNumber(5000)} job(s) across all states`);
      expect(prompts[0]).toContain('safety preflight will refuse');
    } finally {
      r.unmount();
    }
  });

  test('runnable count excludes terminal history but includes every consumable state', () => {
    expect(
      runnableQueueJobs({
        waiting: 1,
        prioritized: 2,
        delayed: 3,
        active: 4,
        paused: 5,
        'waiting-children': 6,
        completed: 100,
        failed: 200,
      })
    ).toBe(21);
    expect(() => runnableQueueJobs({ waiting: Number.NaN })).toThrow('Malformed queue count');
    expect(() => runnableQueueJobs({ active: -1 })).toThrow('Malformed queue count');
    expect(benchmarkQueueJobs(benchmarkCounts({ 'waiting-children': 3, completed: 4 }))).toBe(7);
    expect(() => benchmarkQueueJobs({ waiting: 0 })).toThrow('Malformed queue count');
  });

  test('validates queue names and every success envelope at runtime', () => {
    expect(benchmarkQueueError('benchmark:v2')).toBeNull();
    expect(benchmarkQueueError('bad queue')).toContain('unsupported');
    expect(benchmarkQueueError('x'.repeat(257))).toContain('256');
    expect(() => assertBenchmarkSuccess({}, 'Bulk enqueue')).toThrow('malformed success response');
  });

  test('engine refuses a non-empty queue before bulk-push or pull', async () => {
    useConnectionStore.setState({ baseUrl: 'http://srv', token: '' });
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/dashboard')) return json({ ok: true });
      if (url.includes('/counts')) {
        return json({ ok: true, counts: benchmarkCounts({ waiting: 2 }) });
      }
      return json({ ok: true, ids: [], jobs: [] });
    }) as typeof fetch;

    const h = renderHook(() => useBenchmark());
    await act(async () => {
      await h.result.current.run({
        ...DEFAULT_CONFIG,
        total: 1,
        batch: 1,
        producers: 1,
        workers: 1,
        workerBatch: 1,
        processMs: 0,
      });
    });
    expect(h.result.current.phase).toBe('error');
    expect(h.result.current.live.error).toContain('is not empty (2 job(s) across all states)');
    expect(calls.some((url) => url.includes('/jobs/bulk'))).toBe(false);
    expect(calls.some((url) => url.includes('/pull-batch'))).toBe(false);
    h.unmount();
  });

  test('a pull that beats its bulk response is still recognized and counted by exact id', async () => {
    useConnectionStore.setState({ baseUrl: 'http://srv', token: '' });
    let resolveBulk: ((response: Response) => void) | undefined;
    const bulkResponse = new Promise<Response>((resolve) => {
      resolveBulk = resolve;
    });
    let pulls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/dashboard')) return json({ ok: true });
      if (url.includes('/counts')) return json({ ok: true, counts: benchmarkCounts() });
      if (url.includes('/jobs/bulk')) return bulkResponse;
      if (url.includes('/pull-batch')) {
        pulls += 1;
        if (pulls === 1) {
          setTimeout(() => resolveBulk?.(json({ ok: true, ids: ['bench-1'] })), 5);
          return json({ ok: true, jobs: [{ id: 'bench-1' }] });
        }
        return json({ ok: true, jobs: [] });
      }
      if (url.includes('/heartbeat-batch')) return json({ ok: true, data: { ok: true, count: 1 } });
      if (url.includes('/ack-batch')) return json({ ok: true });
      return json({ ok: true });
    }) as typeof fetch;

    const h = renderHook(() => useBenchmark());
    await act(async () => {
      await h.result.current.run({
        ...DEFAULT_CONFIG,
        total: 1,
        batch: 1,
        producers: 1,
        workers: 1,
        workerBatch: 1,
        processMs: 0,
        payload: 4,
      });
    });
    expect(h.result.current.phase).toBe('done');
    expect(h.result.current.summary).toMatchObject({
      pushed: 1,
      completed: 1,
      pushFailed: 0,
      bytes: 4,
    });
    h.unmount();
  });

  test('refuses ACK when the nested v2.8.55 heartbeat confirms only part of the batch', async () => {
    useConnectionStore.setState({ baseUrl: 'http://srv', token: '' });
    const calls: string[] = [];
    let pulls = 0;
    let bulkBody: unknown;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/dashboard')) return json({ ok: true });
      if (url.includes('/counts')) return json({ ok: true, counts: benchmarkCounts() });
      if (url.includes('/jobs/bulk')) {
        bulkBody = JSON.parse(String(init?.body));
        return json({ ok: true, ids: ['bench-1', 'bench-2'] });
      }
      if (url.includes('/pull-batch')) {
        pulls += 1;
        return json({
          ok: true,
          jobs: pulls === 1 ? [{ id: 'bench-1' }, { id: 'bench-2' }] : [],
        });
      }
      if (url.includes('/heartbeat-batch')) {
        return json({ ok: true, data: { ok: true, count: 1 } });
      }
      if (url.includes('/ack-batch')) return json({ ok: true });
      return json({ ok: false, error: `unexpected ${url}` }, 500);
    }) as typeof fetch;

    const h = renderHook(() => useBenchmark());
    await act(async () => {
      await h.result.current.run({
        ...DEFAULT_CONFIG,
        total: 2,
        batch: 2,
        producers: 1,
        workers: 1,
        workerBatch: 2,
        processMs: 0,
      });
    });

    expect(h.result.current.phase).toBe('error');
    expect(h.result.current.summary).toMatchObject({ completed: 0, ackFailed: 2 });
    expect(h.result.current.live.error).toContain('Heartbeat confirmed 1 of 2');
    expect(calls.some((url) => url.includes('/ack-batch'))).toBe(false);
    const jobs = (bulkBody as { jobs: Array<Record<string, unknown>> }).jobs;
    expect(jobs).toHaveLength(2);
    expect(jobs.every((job) => job.stallTimeout === 120_000)).toBe(true);
    expect(jobs.every((job) => typeof job.customId === 'string')).toBe(true);
    expect(jobs.every((job) => Array.isArray(job.tags))).toBe(true);
    h.unmount();
  });
});
