import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import type { JobFull } from '../src/lib/bqTypes';
import { Diagnostics } from '../src/pages/control/Diagnostics';
import { walkFlow } from '../src/pages/control/Flows';
import { JobInspector } from '../src/pages/control/JobInspector';
import { selectionLabel, withoutActed } from '../src/pages/control/JobsPro';
import {
  JobActionsPanel,
  parseFailureStack,
  parseJobActionNumber,
} from '../src/pages/control/job/JobActionsPanel';
import { previewDelays, remainingRetries } from '../src/pages/control/job/JobBackoff';
import { JobLogs } from '../src/pages/control/job/JobLogs';
import { MetricsPro } from '../src/pages/control/MetricsPro';
import { configSig, useSyncedConfig } from '../src/pages/control/queue/ConfigForms';
import {
  cleanArgs,
  promoteCountArgs,
  rateLimitArgs,
} from '../src/pages/control/queue/QueueActions';
import { duplicateKeys } from '../src/pages/control/server/EnvVarsEditor';
import { discoverAllQueues, Jobs, jobDataName, MAX_ALL_QUEUE_JOB_FANOUT } from '../src/pages/Jobs';
import { ensureDom, renderHook, settle } from './domSetup';

// Regression tests for the "job-queue-pages" audit package: honest reporting of
// failed sub-fetches (Flows), last-to-START-wins sequencing (JobLogs, Diagnostics
// ping), confirm-text/request agreement (Clean), the save-vs-poll baseline race
// (ConfigForms) and two off-by-one/pluralization readouts.

const realFetch = globalThis.fetch;
const realConfirm = window.confirm;

beforeEach(() => {
  ensureDom();
  useConnectionStore.setState({ baseUrl: 'http://srv', token: '', agentToken: '' });
  window.confirm = () => true;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  window.confirm = realConfirm;
  useConnectionStore.setState({ baseUrl: '/api', token: '', agentToken: '' });
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Mount a component into a throwaway root under act(). */
function render(element: React.ReactElement) {
  ensureDom();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(element));
  return { container, unmount: () => act(() => root.unmount()) };
}

function clickText(container: HTMLElement, text: string) {
  const btn = [...container.querySelectorAll('button')].find((b) =>
    (b.textContent ?? '').includes(text)
  );
  if (!btn) throw new Error(`no button matching "${text}"`);
  act(() => {
    btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
}

function setValue(element: HTMLInputElement | HTMLSelectElement, value: string) {
  act(() => {
    const prototype =
      element instanceof window.HTMLSelectElement
        ? window.HTMLSelectElement.prototype
        : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
    element.dispatchEvent(new window.Event('input', { bubbles: true }));
    element.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('JobBackoff — remaining attempts', () => {
  const job = (attempts: number, maxAttempts: number) =>
    ({ id: 'j', attempts, maxAttempts }) as JobFull;

  test('a never-run job with 11 max attempts has 10 retry rows, not 11', () => {
    // Pre-fix: remaining was maxAttempts - attempts = 11, so the page claimed
    // "Showing next 10 of 11" while nothing was actually hidden.
    expect(previewDelays(job(0, 11))).toHaveLength(10);
    expect(remainingRetries(job(0, 11))).toBe(10);
  });

  test('the notice only fires when rows were really truncated', () => {
    expect(remainingRetries(job(0, 12))).toBe(11); // 1 row hidden — notice is honest
    expect(previewDelays(job(0, 12))).toHaveLength(10);
  });

  test('a job that has already run is unchanged (remaining === max - attempts)', () => {
    expect(remainingRetries(job(3, 11))).toBe(8);
    expect(previewDelays(job(3, 11))).toHaveLength(8);
  });
});

describe('EnvVarsEditor — duplicate-key warning', () => {
  test('names each duplicated key exactly once regardless of repeat count', () => {
    expect(duplicateKeys(['API_KEY', 'API_KEY', 'API_KEY'])).toEqual(['API_KEY']);
    expect(duplicateKeys(['A', 'A', 'B', 'B', 'C'])).toEqual(['A', 'B']);
  });

  test('trims and ignores blank keys', () => {
    expect(duplicateKeys([' X ', 'X', '', '  '])).toEqual(['X']);
    expect(duplicateKeys(['A', 'B'])).toEqual([]);
  });
});

describe('QueueActions — Clean args match the confirm text', () => {
  test('a blank field is rejected instead of silently becoming 0', () => {
    // Number('') === 0, so pre-fix an emptied Grace field rendered a blank in
    // the prompt while sending grace:0 — the widest possible deletion scope.
    expect(cleanArgs('', '1000').valid).toBe(false);
    expect(cleanArgs('0', '').valid).toBe(false);
    expect(cleanArgs('  ', ' ').valid).toBe(false);
  });

  test('a limit of 0 (an unbounded purge on falsy-checking servers) is rejected', () => {
    expect(cleanArgs('0', '0').valid).toBe(false);
  });

  test('valid input coerces once, so prompt and request quote the same numbers', () => {
    const a = cleanArgs('60000', '500');
    expect(a).toEqual({ grace: 60000, limit: 500, valid: true });
  });

  test('fractional and unsafe integers are rejected', () => {
    expect(cleanArgs('1.5', '100').valid).toBe(false);
    expect(cleanArgs('100', '1.5').valid).toBe(false);
    expect(cleanArgs('9007199254740992', '1').valid).toBe(false);
  });
});

describe('QueueActions — promote count', () => {
  test('blank means all; a supplied count must be a positive safe integer', () => {
    expect(promoteCountArgs('')).toEqual({ valid: true });
    expect(promoteCountArgs('  ')).toEqual({ valid: true });
    expect(promoteCountArgs('1')).toEqual({ count: 1, valid: true });
    expect(promoteCountArgs('0').valid).toBe(false);
    expect(promoteCountArgs('-1').valid).toBe(false);
    expect(promoteCountArgs('1.5').valid).toBe(false);
    expect(promoteCountArgs('9007199254740992').valid).toBe(false);
  });
});

describe('QueueActions — rate-limit body', () => {
  test('keeps blank optionals absent and rejects invalid values', () => {
    expect(rateLimitArgs('100', '', '')).toEqual({ limit: 100, duration: 0, valid: false });
    expect(rateLimitArgs('100', '60000', '3600000')).toEqual({
      limit: 100,
      duration: 60000,
      ttl: 3600000,
      valid: true,
    });
    expect(rateLimitArgs('0', '', '').valid).toBe(false);
    expect(rateLimitArgs('10', '-1', '').valid).toBe(false);
    expect(rateLimitArgs('10', '', '1.5').valid).toBe(false);
    expect(rateLimitArgs('9007199254740992', '', '').valid).toBe(false);
  });
});

describe('JobActionsPanel — numeric request validation', () => {
  test('failed and completed jobs expose no retry or requeue control', () => {
    let actions = 0;
    for (const state of ['failed', 'completed']) {
      const { container, unmount } = render(
        createElement(JobActionsPanel, {
          job: { id: `${state}-job`, queue: 'orders', state },
          busy: false,
          act: () => {
            actions += 1;
          },
        })
      );
      expect(container.textContent).not.toContain('Retry from DLQ');
      expect(container.textContent).not.toContain('Requeue');
      expect(container.textContent).toContain('unavailable');
      unmount();
      container.remove();
    }
    expect(actions).toBe(0);
  });

  test('delay and priority stay inside server-safe integer bounds', () => {
    expect(parseJobActionNumber('0', 'delay')).toEqual({ ok: true, value: 0 });
    expect(parseJobActionNumber('31536000000', 'delay').ok).toBe(true);
    expect(parseJobActionNumber('-1', 'delay').ok).toBe(false);
    expect(parseJobActionNumber('1.5', 'delay').ok).toBe(false);
    expect(parseJobActionNumber('31536000001', 'delay').ok).toBe(false);
    expect(parseJobActionNumber('-1000000', 'priority').ok).toBe(true);
    expect(parseJobActionNumber('1000001', 'priority').ok).toBe(false);
    expect(parseJobActionNumber('1.5', 'priority').ok).toBe(false);
  });

  test('progress accepts finite values from 0 through 100 without clamping', () => {
    expect(parseJobActionNumber('12.5', 'progress')).toEqual({ ok: true, value: 12.5 });
    expect(parseJobActionNumber('-1', 'progress').ok).toBe(false);
    expect(parseJobActionNumber('101', 'progress').ok).toBe(false);
    expect(parseJobActionNumber('NaN', 'progress').ok).toBe(false);
    expect(parseJobActionNumber('', 'progress').ok).toBe(false);
  });
});

describe('JobActionsPanel — failure stack validation', () => {
  test('normalizes blank lines but never silently truncates frames', () => {
    expect(parseFailureStack(' frame one \n\n frame two ')).toEqual({
      ok: true,
      stack: ['frame one', 'frame two'],
    });
    expect(parseFailureStack('')).toEqual({ ok: true });
    expect(
      parseFailureStack(Array.from({ length: 100 }, (_, i) => `frame ${i}`).join('\n')).ok
    ).toBe(true);
    expect(
      parseFailureStack(Array.from({ length: 101 }, (_, i) => `frame ${i}`).join('\n')).ok
    ).toBe(false);
  });

  test('rejects pathological individual and aggregate stack sizes', () => {
    expect(parseFailureStack('x'.repeat(16_385)).ok).toBe(false);
    expect(
      parseFailureStack(Array.from({ length: 100 }, () => 'x'.repeat(3000)).join('\n')).ok
    ).toBe(false);
  });
});

describe('Flows — a failed job fetch is reported, not hidden', () => {
  test('walkFlow counts nodes it could not load', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/jobs/root')) {
        return json({
          ok: true,
          job: {
            id: 'root',
            queue: 'q',
            state: 'completed',
            parentId: null,
            childrenIds: ['b'],
            dependsOn: [],
          },
        });
      }
      return json({ ok: false, error: 'boom' }, 500);
    }) as typeof fetch;

    const g = await walkFlow('root');
    expect(g.jobs.size).toBe(2);
    // Pre-fix this graph was indistinguishable from a complete one: the child
    // rendered as a real node with no signal that its own subtree was lost.
    expect(g.failed).toBe(1);
  });

  test('a fully readable flow reports zero failures', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/jobs/root')) {
        return json({
          ok: true,
          job: {
            id: 'root',
            queue: 'q',
            state: 'completed',
            parentId: null,
            childrenIds: ['b'],
            dependsOn: [],
          },
        });
      }
      return json({
        ok: true,
        job: {
          id: 'b',
          queue: 'q',
          state: 'completed',
          parentId: 'root',
          childrenIds: [],
          dependsOn: [],
        },
      });
    }) as typeof fetch;

    const g = await walkFlow('root');
    expect(g.failed).toBe(0);
    expect(g.truncated).toBe(false);
    expect(g.edges).toHaveLength(1);
  });
});

describe('ConfigForms — save must not overwrite a baseline the poll advanced', () => {
  test('a mid-save external change stays adopted after the save settles', () => {
    const S = { stallInterval: 30000, enabled: true };
    const Y = { stallInterval: 60000, enabled: true };
    const P = { stallInterval: 5000, enabled: true };

    const h = renderHook((cfg: typeof S) => useSyncedConfig(cfg), S);
    // The user edits the draft and the save starts: baseline captured here.
    act(() => h.result.current[1](P));
    const markSaved = h.result.current[2]();

    // Mid-save, the 3s poll delivers an EXTERNAL change; the form re-seeds to Y.
    h.rerender(Y);
    expect(h.result.current[0]).toEqual(Y);

    // Our save resolves. Pre-fix this advanced the baseline to sig(P) while the
    // form displayed Y, so the next poll returning P was treated as "already
    // adopted" and the form was stranded on a value the server did not have.
    markSaved(P);
    h.rerender(P);
    expect(h.result.current[0]).toEqual(P);
    h.unmount();
  });

  test('an uncontested save still suppresses the echo of our own write', () => {
    const S = { stallInterval: 30000, enabled: true };
    const P = { stallInterval: 5000, enabled: true };
    const h = renderHook((cfg: typeof S) => useSyncedConfig(cfg), S);
    act(() => h.result.current[1](P));
    const markSaved = h.result.current[2]();
    markSaved(P);
    // The server echoes our own payload — it must not clobber a re-edit.
    const reEdit = { stallInterval: 7000, enabled: true };
    act(() => h.result.current[1](reEdit));
    h.rerender({ ...P });
    expect(h.result.current[0]).toEqual(reEdit);
    h.unmount();
  });

  test('configSig is key-order insensitive', () => {
    expect(configSig({ a: 1, b: 2 })).toBe(configSig({ b: 2, a: 1 }));
  });
});

describe('JobsPro — the selection count matches what the buttons act on', () => {
  test('a filter that hides selected rows is spelled out, not counted as actionable', () => {
    expect(selectionLabel(25, 25)).toBe('25 selected');
    expect(selectionLabel(1, 25)).toBe('1 of 25 selected match this filter');
  });

  test('a bulk action drops only the ids it ran on', () => {
    const selected = new Set(['a', 'b', 'c']);
    // Pre-fix this was `setSelected(new Set())`: 'b' and 'c' were discarded
    // although the action (filtered to the visible row) never touched them.
    expect([...withoutActed(selected, ['a'])]).toEqual(['b', 'c']);
    expect([...withoutActed(selected, ['a', 'b', 'c'])]).toEqual([]);
  });
});

describe('JobInspector — a fetch failure is never rendered as a fact', () => {
  const job = { id: 'j1', queue: 'q', state: 'completed', maxAttempts: 1 };

  test('uses Bunqueue 2.8.57 embedded returnvalue without a second result request', async () => {
    let resultGets = 0;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/result')) {
        resultGets += 1;
        return Promise.resolve(json({ ok: true, id: 'j1', result: 'legacy' }));
      }
      if (url.endsWith('/logs')) {
        return Promise.resolve(json({ ok: true, data: { logs: [], count: 0 } }));
      }
      return Promise.resolve(
        json({ ok: true, job: { ...job, name: 'render-report', returnvalue: { done: true } } })
      );
    }) as typeof fetch;

    const { container, unmount } = render(
      createElement(MemoryRouter, { initialEntries: ['/job?id=j1'] }, createElement(JobInspector))
    );
    await settle(10);
    expect(resultGets).toBe(0);
    expect(container.textContent).toContain('render-report');
    expect(container.textContent).toContain('done');
    unmount();
  });

  test('a failed result fetch says so instead of "No result stored"', async () => {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/result')) return Promise.resolve(json({ ok: false, error: 'bad' }, 502));
      return Promise.resolve(json({ ok: true, job }));
    }) as typeof fetch;

    const { container, unmount } = render(
      createElement(MemoryRouter, { initialEntries: ['/job?id=j1'] }, createElement(JobInspector))
    );
    await settle(10);
    const text = container.textContent ?? '';
    expect(text).toContain("Couldn't load result");
    expect(text).not.toContain('No result stored for this job.');
    unmount();
  });

  test('a malformed successful result envelope is reported instead of treated as empty', async () => {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/result')) return Promise.resolve(json({ ok: true }));
      return Promise.resolve(json({ ok: true, job }));
    }) as typeof fetch;

    const { container, unmount } = render(
      createElement(MemoryRouter, { initialEntries: ['/job?id=j1'] }, createElement(JobInspector))
    );
    await settle(10);
    const text = container.textContent ?? '';
    expect(text).toContain("Couldn't load result");
    expect(text).toContain('Invalid job result response');
    expect(text).not.toContain('No result stored for this job.');
    unmount();
  });

  test('a mutation that succeeded is not reported as failed when the reload errors', async () => {
    let jobGets = 0;
    const delayedJob = { ...job, state: 'delayed' };
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? 'GET') !== 'GET') return Promise.resolve(json({ ok: true }));
      if (url.endsWith('/result')) return Promise.resolve(json({ ok: true, result: 1 }));
      jobGets += 1;
      // The post-action read-back (2nd GET) hits a proxy blip.
      if (jobGets > 1) return Promise.resolve(json({ ok: false, error: 'Failed to fetch' }, 502));
      return Promise.resolve(json({ ok: true, job: delayedJob }));
    }) as typeof fetch;

    const { container, unmount } = render(
      createElement(MemoryRouter, { initialEntries: ['/job?id=j1'] }, createElement(JobInspector))
    );
    await settle(10);
    clickText(container, 'Promote (run now)');
    await settle(10);
    const text = container.textContent ?? '';
    // Pre-fix the red reload error REPLACED the success line, so the operator
    // re-ran an action the server had already accepted.
    expect(text).toContain('Promote ✓');
    expect(text).toContain("couldn't reload");
    unmount();
  });
});

describe('JobLogs — a stale read must not undo a just-run mutation', () => {
  test('keeps path-safe opaque job punctuation byte-for-byte', async () => {
    const urls: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      urls.push(String(input));
      return Promise.resolve(json({ ok: true, data: { logs: [], count: 0 } }));
    }) as typeof fetch;
    const { unmount } = render(createElement(JobLogs, { jobId: 'job:@+' }));
    try {
      await settle(5);
      expect(urls).toEqual(['http://srv/jobs/job:@+/logs']);
    } finally {
      unmount();
    }
  });

  test('a 401 event identifies the exact server target and credential used', async () => {
    useConnectionStore.setState({
      baseUrl: 'https://logs-server.test/api',
      token: 'logs-token',
    });
    globalThis.fetch = (() =>
      Promise.resolve(json({ ok: false, error: 'unauthorized' }, 401))) as typeof fetch;
    const details: unknown[] = [];
    const onAuth = (event: Event) => details.push((event as CustomEvent).detail);
    window.addEventListener('auth:required', onAuth);
    const { container, unmount } = render(createElement(JobLogs, { jobId: 'j1' }));
    try {
      await settle(5);
      expect(container.textContent).toContain('unauthorized');
      expect(details).toEqual([
        {
          scope: 'server',
          auth: 'Bearer logs-token',
          target: 'https://logs-server.test/api',
        },
      ]);
    } finally {
      window.removeEventListener('auth:required', onAuth);
      unmount();
    }
  });

  test('an in-flight refresh started BEFORE the clear cannot resurrect the logs', async () => {
    const slow = deferred<Response>();
    let gets = 0;
    let deletes = 0;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'DELETE') {
        deletes += 1;
        return Promise.resolve(json({ ok: true }));
      }
      gets += 1;
      if (gets === 1) {
        return Promise.resolve(json({ ok: true, data: { logs: ['old line'], count: 1 } }));
      }
      if (gets === 2) return slow.promise; // Refresh — resolves LAST
      return Promise.resolve(json({ ok: true, data: { logs: [], count: 0 } })); // post-clear
    }) as typeof fetch;

    const originalConfirm = window.confirm;
    window.confirm = (() => true) as typeof window.confirm;
    const { container, unmount } = render(createElement(JobLogs, { jobId: 'j1' }));
    try {
      await settle(5);
      expect(container.textContent).toContain('old line');

      clickText(container, 'Refresh'); // read #2 starts, hangs
      await settle(2);
      const clear = [...container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('Clear logs')
      );
      if (!clear) throw new Error('Clear logs button not found');
      act(() => {
        clear.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        clear.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      }); // exactly one DELETE + read #3 (fast)
      await settle(5);
      expect(deletes).toBe(1);
      expect(container.textContent).not.toContain('old line');

      // The pre-DELETE snapshot lands now. Pre-fix it wrote last and the wiped
      // lines (and the count) reappeared with no error shown.
      await act(async () => {
        slow.resolve(json({ ok: true, data: { logs: ['old line'], count: 1 } }));
        await new Promise((r) => setTimeout(r, 5));
      });
      expect(container.textContent).not.toContain('old line');
    } finally {
      window.confirm = originalConfirm;
      unmount();
    }
  });

  test('a same-tick double Add sends one non-idempotent POST', async () => {
    const slowPost = deferred<Response>();
    const posts: Array<{ body: unknown; signal?: AbortSignal }> = [];
    let gets = 0;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'POST') {
        posts.push({
          body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
          signal: init?.signal,
        });
        return slowPost.promise;
      }
      gets += 1;
      return Promise.resolve(
        json({
          ok: true,
          data: gets === 1 ? { logs: [], count: 0 } : { logs: ['only once'], count: 1 },
        })
      );
    }) as typeof fetch;

    const { container, unmount } = render(createElement(JobLogs, { jobId: 'j1' }));
    try {
      await settle(5);
      const input = container.querySelector('input[aria-label="Log message"]') as HTMLInputElement;
      setValue(input, 'only once');
      expect(input.value).toBe('only once');
      const level = container.querySelector('select[aria-label="Log level"]') as HTMLSelectElement;
      const form = input.closest('form');
      if (!form) throw new Error('Log form not found');

      act(() => {
        Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set?.call(
          level,
          'warn'
        );
        // Keep React's render closure deliberately stale: the submit handler
        // must read the live form control values from this same browser task.
        form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
        form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      });
      expect(posts).toHaveLength(1);
      expect(posts[0]?.body).toEqual({ message: 'only once', level: 'warn' });

      slowPost.resolve(json({ ok: true }));
      await settle(10);
      expect(posts).toHaveLength(1);
      expect(container.textContent).toContain('only once');
      expect(input.value).toBe('');
    } finally {
      unmount();
    }
  });

  test('an accepted Add preserves a newer draft typed while its POST is pending', async () => {
    const slowPost = deferred<Response>();
    const posts: unknown[] = [];
    let gets = 0;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST') {
        posts.push(typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body);
        return slowPost.promise;
      }
      gets += 1;
      return Promise.resolve(
        json({
          ok: true,
          data: gets === 1 ? { logs: [], count: 0 } : { logs: ['first draft'], count: 1 },
        })
      );
    }) as typeof fetch;

    const { container, unmount } = render(createElement(JobLogs, { jobId: 'j1' }));
    try {
      await settle(5);
      const input = container.querySelector('input[aria-label="Log message"]') as HTMLInputElement;
      const form = input.closest('form');
      if (!form) throw new Error('Log form not found');

      setValue(input, 'first draft');
      act(() => {
        form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      });
      expect(posts).toEqual([{ message: 'first draft', level: 'info' }]);

      setValue(input, 'second draft');
      expect(input.value).toBe('second draft');

      slowPost.resolve(json({ ok: true }));
      await settle(10);

      expect(posts).toHaveLength(1);
      expect(container.textContent).toContain('first draft');
      expect(input.value).toBe('second draft');
    } finally {
      unmount();
    }
  });

  test('an accepted Add preserves the message when only its draft level changed', async () => {
    const slowPost = deferred<Response>();
    const posts: unknown[] = [];
    let gets = 0;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST') {
        posts.push(typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body);
        return slowPost.promise;
      }
      gets += 1;
      return Promise.resolve(
        json({
          ok: true,
          data: gets === 1 ? { logs: [], count: 0 } : { logs: ['same text'], count: 1 },
        })
      );
    }) as typeof fetch;

    const { container, unmount } = render(createElement(JobLogs, { jobId: 'j1' }));
    try {
      await settle(5);
      const input = container.querySelector('input[aria-label="Log message"]') as HTMLInputElement;
      const level = container.querySelector('select[aria-label="Log level"]') as HTMLSelectElement;
      const form = input.closest('form');
      if (!form) throw new Error('Log form not found');

      setValue(input, 'same text');
      act(() => {
        form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      });
      expect(posts).toEqual([{ message: 'same text', level: 'info' }]);
      setValue(level, 'error');

      slowPost.resolve(json({ ok: true }));
      await settle(10);

      expect(posts).toHaveLength(1);
      expect(input.value).toBe('same text');
      expect(level.value).toBe('error');
    } finally {
      unmount();
    }
  });

  test('a malformed 2xx mutation is an error and never triggers an authoritative reload', async () => {
    let gets = 0;
    let posts = 0;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST') {
        posts += 1;
        return Promise.resolve(json({ accepted: true }));
      }
      gets += 1;
      return Promise.resolve(json({ ok: true, data: { logs: [], count: 0 } }));
    }) as typeof fetch;

    const { container, unmount } = render(createElement(JobLogs, { jobId: 'j1' }));
    try {
      await settle(5);
      const input = container.querySelector('input[aria-label="Log message"]') as HTMLInputElement;
      setValue(input, 'must be acknowledged');
      const form = input.closest('form');
      if (!form) throw new Error('Log form not found');
      act(() => {
        form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      });
      await settle(5);

      expect(posts).toBe(1);
      expect(gets).toBe(1);
      expect(container.textContent).toContain(
        'Invalid log mutation response: expected { ok: true }'
      );
      expect(input.value).toBe('must be acknowledged');
    } finally {
      unmount();
    }
  });

  test('an old-target mutation cannot reload or publish into the new target', async () => {
    useConnectionStore.setState({ baseUrl: 'https://server-a.test/api', token: 'token-a' });
    const slowDelete = deferred<Response>();
    const calls: Array<{
      url: string;
      method: string;
      auth: string | null;
      signal?: AbortSignal;
    }> = [];
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const call = {
        url: String(input),
        method: init?.method ?? 'GET',
        auth: new Headers(init?.headers).get('Authorization'),
        signal: init?.signal,
      };
      calls.push(call);
      if (call.method === 'DELETE' && call.url.startsWith('https://server-a.test')) {
        return slowDelete.promise; // deliberately ignores abort
      }
      if (call.method === 'GET' && call.url.startsWith('https://server-a.test')) {
        return Promise.resolve(json({ ok: true, data: { logs: ['server-a'], count: 1 } }));
      }
      if (call.method === 'GET' && call.url.startsWith('https://server-b.test')) {
        return Promise.resolve(json({ ok: true, data: { logs: ['server-b'], count: 1 } }));
      }
      return Promise.resolve(json({ ok: false, error: `unexpected request: ${call.url}` }, 500));
    }) as typeof fetch;

    const originalConfirm = window.confirm;
    window.confirm = (() => true) as typeof window.confirm;
    const { container, unmount } = render(createElement(JobLogs, { jobId: 'shared-job' }));
    try {
      await settle(5);
      expect(container.textContent).toContain('server-a');
      clickText(container, 'Clear logs');
      const oldDelete = calls.find((call) => call.method === 'DELETE');
      expect(oldDelete?.signal?.aborted).toBeFalse();

      act(() =>
        useConnectionStore.setState({
          baseUrl: 'https://server-b.test/api',
          token: 'token-b',
        })
      );
      expect(oldDelete?.signal?.aborted).toBeTrue();
      await settle(10);
      expect(container.textContent).toContain('server-b');
      expect(container.textContent).not.toContain('server-a');

      slowDelete.resolve(json({ ok: true }));
      await settle(10);
      expect(container.textContent).toContain('server-b');
      expect(
        calls.filter(
          (call) => call.method === 'GET' && call.url.startsWith('https://server-a.test')
        )
      ).toHaveLength(1);
      expect(
        calls.map((call) => ({
          url: call.url,
          auth: call.auth,
        }))
      ).toEqual([
        {
          url: 'https://server-a.test/api/jobs/shared-job/logs',
          auth: 'Bearer token-a',
        },
        {
          url: 'https://server-a.test/api/jobs/shared-job/logs',
          auth: 'Bearer token-a',
        },
        {
          url: 'https://server-b.test/api/jobs/shared-job/logs',
          auth: 'Bearer token-b',
        },
      ]);
    } finally {
      window.confirm = originalConfirm;
      unmount();
    }
  });

  test('a failed read-back states that the clear already succeeded', async () => {
    let gets = 0;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'DELETE') return Promise.resolve(json({ ok: true }));
      gets += 1;
      if (gets === 1) {
        return Promise.resolve(json({ ok: true, data: { logs: ['old line'], count: 1 } }));
      }
      return Promise.resolve(json({ ok: false, error: 'reload down' }, 502));
    }) as typeof fetch;

    const originalConfirm = window.confirm;
    window.confirm = (() => true) as typeof window.confirm;
    const { container, unmount } = render(createElement(JobLogs, { jobId: 'j1' }));
    try {
      await settle(5);
      clickText(container, 'Clear logs');
      await settle(10);
      expect(container.textContent).toContain(
        "Log clearing succeeded, but couldn't reload logs: reload down"
      );
      expect(container.textContent).not.toContain('old line');
    } finally {
      window.confirm = originalConfirm;
      unmount();
    }
  });

  test('unmount aborts a pending load even when fetch resolves late', async () => {
    const slow = deferred<Response>();
    let signal: AbortSignal | undefined;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal;
      return slow.promise;
    }) as typeof fetch;

    const { container, unmount } = render(createElement(JobLogs, { jobId: 'j1' }));
    expect(signal).toBeDefined();
    unmount();
    expect(signal?.aborted).toBeTrue();
    slow.resolve(json({ ok: true, data: { logs: ['late'], count: 1 } }));
    await settle(5);
    expect(container.textContent).toBe('');
  });
});

describe('Jobs classic — async failures and all-queue scope', () => {
  test('treats non-string data.name as unnamed and never calls string methods on it', () => {
    expect(jobDataName({ name: 123 })).toBeNull();
    expect(jobDataName({ name: { nested: true } })).toBeNull();
    expect(jobDataName({ name: 'report' })).toBe('report');
  });

  test('rejects overlapping queue pages instead of silently omitting queues', async () => {
    let calls = 0;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const offset = Number(url.searchParams.get('offset'));
      calls += 1;
      const names =
        offset === 0 ? Array.from({ length: 500 }, (_, index) => `q${index}`) : ['q499'];
      return Promise.resolve(
        json({
          ok: true,
          queues: names.map((name) => ({
            name,
            waiting: 0,
            delayed: 0,
            active: 0,
            dlq: 0,
            paused: false,
          })),
          total: 501,
          limit: 500,
          offset,
          timestamp: Date.now(),
        })
      );
    }) as typeof fetch;

    await expect(discoverAllQueues()).rejects.toThrow('pages overlap at queue q499');
    expect(calls).toBe(2);
  });

  test('rejects premature short pages and totals that change during discovery', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        json({ ok: true, queues: [{ name: 'q1' }], total: 2, limit: 500, offset: 0 })
      )) as typeof fetch;
    await expect(discoverAllQueues()).rejects.toThrow('malformed or unsafe page');

    let calls = 0;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const offset = Number(new URL(String(input)).searchParams.get('offset'));
      calls += 1;
      const total = offset === 0 ? 501 : 502;
      const names =
        offset === 0 ? Array.from({ length: 500 }, (_, index) => `q${index}`) : ['q500', 'q501'];
      return Promise.resolve(
        json({
          ok: true,
          queues: names.map((name) => ({ name })),
          total,
          limit: 500,
          offset,
        })
      );
    }) as typeof fetch;
    await expect(discoverAllQueues()).rejects.toThrow('malformed or unsafe page');
    expect(calls).toBe(2);
  });

  test('rejects hostile totals before starting an unbounded discovery fan-out', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        json({
          ok: true,
          queues: [],
          total: Number.MAX_SAFE_INTEGER,
          limit: 500,
          offset: 0,
          timestamp: Date.now(),
        })
      )) as typeof fetch;

    await expect(discoverAllQueues()).rejects.toThrow('malformed or unsafe page');
  });

  test('queue discovery and overview failures are visible, never a factual empty/zero view', async () => {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/dashboard/queues')) {
        return Promise.resolve(json({ ok: false, error: 'discovery down' }, 503));
      }
      if (url.endsWith('/dashboard')) {
        return Promise.resolve(json({ ok: false, error: 'overview down' }, 503));
      }
      return Promise.resolve(json({ ok: false, error: 'unexpected request' }, 500));
    }) as typeof fetch;

    const { container, unmount } = render(createElement(MemoryRouter, {}, createElement(Jobs)));
    await settle(12);
    const text = container.textContent ?? '';
    expect(text).toContain('Queue discovery unavailable — discovery down');
    expect(text).toContain('Job totals unavailable — overview down');
    expect(text).not.toContain('No jobs found.');
    const total = [...container.querySelectorAll('div')].find(
      (node) => node.textContent === 'Total'
    )?.parentElement;
    expect(total?.textContent).toContain('—');
    expect(
      [...container.querySelectorAll('span')].some((node) => node.textContent === 'Live')
    ).toBe(false);
    unmount();
  });

  test('all queues means every discovered queue and reports per-queue list failures', async () => {
    const names = Array.from({ length: 26 }, (_, i) => `q${i + 1}`);
    let listCalls = 0;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/dashboard/queues')) {
        return Promise.resolve(
          json({
            ok: true,
            queues: names.map((name) => ({
              name,
              waiting: 0,
              delayed: 0,
              active: 0,
              dlq: 0,
              paused: false,
            })),
            total: names.length,
            limit: 500,
            offset: 0,
            timestamp: Date.now(),
          })
        );
      }
      if (url.endsWith('/dashboard')) {
        return Promise.resolve(
          json({
            ok: true,
            stats: {
              waiting: 0,
              active: 0,
              delayed: 0,
              completed: 1,
              dlq: 0,
              totalPushed: 1,
              totalPulled: 1,
              totalCompleted: 1,
              totalFailed: 0,
              uptime: 1,
            },
          })
        );
      }
      if (url.includes('/jobs/list')) {
        listCalls += 1;
        const queue = decodeURIComponent(url.match(/\/queues\/([^/]+)\/jobs\/list/)?.[1] ?? '');
        if (queue === 'q26') {
          return Promise.resolve(json({ ok: false, error: 'q26 list down' }, 503));
        }
        return Promise.resolve(
          json({
            ok: true,
            jobs:
              queue === 'q1'
                ? [{ id: 'job-q1', queue, state: 'waiting', createdAt: Date.now() }]
                : [],
          })
        );
      }
      return Promise.resolve(json({ ok: false, error: 'unexpected request' }, 500));
    }) as typeof fetch;

    const { container, unmount } = render(createElement(MemoryRouter, {}, createElement(Jobs)));
    await settle(40);
    const text = container.textContent ?? '';
    expect(listCalls).toBe(26);
    expect(text).toContain('Queried all 26 discovered queues');
    expect(text).toContain('Could not load jobs from 1 of 26 queues: q26 (q26 list down)');
    expect(text).toContain('job-q1');
    expect(text).not.toContain('No jobs found.');
    unmount();
  });

  test('blocks all-queue browsing before a large periodic job-list fan-out', async () => {
    const names = Array.from({ length: MAX_ALL_QUEUE_JOB_FANOUT + 1 }, (_, i) => `q${i + 1}`);
    let listCalls = 0;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/dashboard/queues')) {
        return Promise.resolve(
          json({
            ok: true,
            queues: names.map((name) => ({
              name,
              waiting: 0,
              delayed: 0,
              active: 0,
              dlq: 0,
              paused: false,
            })),
            total: names.length,
            limit: 500,
            offset: 0,
            timestamp: Date.now(),
          })
        );
      }
      if (url.endsWith('/dashboard')) {
        return Promise.resolve(
          json({
            ok: true,
            stats: { waiting: 0, active: 0, totalCompleted: 0, totalFailed: 0 },
          })
        );
      }
      if (url.includes('/jobs/list')) listCalls += 1;
      return Promise.resolve(json({ ok: true, jobs: [] }));
    }) as typeof fetch;

    const { container, unmount } = render(createElement(MemoryRouter, {}, createElement(Jobs)));
    await settle(20);
    expect(listCalls).toBe(0);
    expect(container.textContent).toContain(
      `All-queue job browsing is limited to ${MAX_ALL_QUEUE_JOB_FANOUT} queues`
    );
    expect(
      [...container.querySelectorAll('span')].some((node) => node.textContent === 'Live')
    ).toBe(false);
    unmount();
  });

  test('server retarget aborts the old pinned job-list pool without mixing credentials', async () => {
    const names = Array.from({ length: 10 }, (_, index) => `q${index + 1}`);
    const oldSignals: AbortSignal[] = [];
    const listCalls: Array<{ url: string; auth: string | null }> = [];
    useConnectionStore.setState({ baseUrl: 'http://srv', token: 'alpha' });
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/dashboard/queues')) {
        const currentNames = url.startsWith('http://server-b.test') ? ['qb'] : names;
        return Promise.resolve(
          json({
            ok: true,
            queues: currentNames.map((name) => ({
              name,
              waiting: 0,
              delayed: 0,
              active: 0,
              dlq: 0,
              paused: false,
            })),
            total: currentNames.length,
            limit: 500,
            offset: 0,
            timestamp: Date.now(),
          })
        );
      }
      if (url.endsWith('/dashboard')) {
        return Promise.resolve(
          json({
            ok: true,
            stats: { waiting: 0, active: 0, totalCompleted: 0, totalFailed: 0 },
          })
        );
      }
      if (url.includes('/jobs/list')) {
        listCalls.push({ url, auth: new Headers(init?.headers).get('Authorization') });
        if (url.startsWith('http://srv/')) {
          const signal = init?.signal;
          if (!signal) throw new Error('job-list request has no lifecycle signal');
          oldSignals.push(signal);
          return new Promise<Response>((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => reject(new DOMException('Aborted', 'AbortError')),
              { once: true }
            );
          });
        }
        return Promise.resolve(
          json({
            ok: true,
            jobs: [{ id: 'job-b', queue: 'qb', state: 'waiting', createdAt: Date.now() }],
          })
        );
      }
      return Promise.resolve(json({ ok: false, error: `unexpected ${url}` }, 500));
    }) as typeof fetch;

    const { container, unmount } = render(createElement(MemoryRouter, {}, createElement(Jobs)));
    await settle(20);
    expect(oldSignals).toHaveLength(8);

    act(() => {
      useConnectionStore.setState({ baseUrl: 'http://server-b.test', token: 'bravo' });
    });
    await settle(30);
    expect(oldSignals.every((signal) => signal.aborted)).toBe(true);
    expect(listCalls.filter((call) => call.url.startsWith('http://srv/'))).toHaveLength(8);
    expect(
      listCalls
        .filter((call) => call.url.startsWith('http://srv/'))
        .every((call) => call.auth === 'Bearer alpha')
    ).toBe(true);
    expect(listCalls.filter((call) => call.url.startsWith('http://server-b.test/'))).toEqual([
      expect.objectContaining({ auth: 'Bearer bravo' }),
    ]);
    expect(container.textContent).toContain('Queried all 1 discovered queues');
    expect(container.textContent).toContain('job-b');
    unmount();
  });

  test('classic jobs never exposes cancel and cannot issue a job DELETE', async () => {
    let deletes = 0;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/dashboard/queues')) {
        return Promise.resolve(
          json({ ok: true, queues: [{ name: 'orders' }], total: 1, limit: 500, offset: 0 })
        );
      }
      if (url.endsWith('/dashboard')) {
        return Promise.resolve(
          json({
            ok: true,
            stats: {
              waiting: 1,
              active: 0,
              delayed: 0,
              totalCompleted: 0,
              totalFailed: 0,
            },
          })
        );
      }
      if (url.includes('/jobs/list')) {
        return Promise.resolve(
          json({
            ok: true,
            jobs: [{ id: 'job-1', queue: 'orders', state: 'waiting', createdAt: 1 }],
          })
        );
      }
      if (url.endsWith('/jobs/job-1') && init?.method === 'DELETE') {
        deletes += 1;
        return Promise.resolve(json({ ok: true }));
      }
      return Promise.resolve(json({ ok: false, error: `unexpected ${url}` }, 500));
    }) as typeof fetch;

    const { container, unmount } = render(createElement(MemoryRouter, {}, createElement(Jobs)));
    try {
      await settle(25);
      const cancel = container.querySelector<HTMLButtonElement>('button[aria-label="Cancel job"]');
      expect(cancel).toBeNull();
      expect(container.textContent).toContain('Delete unavailable');
      expect(deletes).toBe(0);
    } finally {
      unmount();
    }
  });
});

describe('MetricsPro — sampler state is never presented as live zeroes', () => {
  test('shows connecting, then the sampler error, with unknown values and no Live badge', async () => {
    const dashboard = deferred<Response>();
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/queues/summary')) return Promise.resolve(json([]));
      if (url.endsWith('/stats')) {
        return Promise.resolve(
          json({
            ok: true,
            stats: {
              completed: 0,
              failed: 0,
              waiting: 0,
              prioritized: 0,
              active: 0,
              delayed: 0,
              'waiting-children': 0,
            },
          })
        );
      }
      if (url.endsWith('/dashboard')) return dashboard.promise;
      return Promise.resolve(json({ ok: false, error: 'unexpected request' }, 500));
    }) as typeof fetch;

    const { container, unmount } = render(createElement(MetricsPro));
    await settle(2);
    expect(container.textContent).toContain('Connecting live telemetry…');

    await act(async () => {
      dashboard.resolve(json({ ok: false, error: 'sampler down' }, 503));
      await new Promise((resolve) => setTimeout(resolve, 8));
    });
    const text = container.textContent ?? '';
    expect(text).toContain('Live telemetry unavailable — sampler down');
    const push = [...container.querySelectorAll('div')].find(
      (node) => node.textContent === 'Push/sec'
    )?.parentElement;
    expect(push?.textContent).toContain('—');
    expect(
      [...container.querySelectorAll('span')].some((node) => node.textContent === 'Live')
    ).toBe(false);
    expect(container.querySelector('[aria-label="throughput chart"]')).toBeNull();
    unmount();
  });
});

describe('Diagnostics — partial source failures stay explicit', () => {
  test('failed storage/stats never become Healthy, none, or zero totals', async () => {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/health')) {
        return Promise.resolve(
          json({
            ok: true,
            status: 'healthy',
            version: '2.8.55',
            uptime: 60,
            memory: { heapUsed: 1, heapTotal: 2, rss: 3 },
            connections: { tcp: 1, ws: 2, sse: 3 },
          })
        );
      }
      if (url.endsWith('/storage')) {
        return Promise.resolve(json({ ok: false, error: 'disk probe down' }, 500));
      }
      if (url.endsWith('/stats')) {
        return Promise.resolve(json({ ok: false, error: 'stats probe down' }, 500));
      }
      return Promise.resolve(json({ ok: false, error: 'unexpected request' }, 500));
    }) as typeof fetch;

    const { container, unmount } = render(createElement(Diagnostics));
    await settle(10);
    const text = container.textContent ?? '';
    expect(text).toContain('Storage diagnostics unavailable — disk probe down');
    expect(text).toContain('Server totals unavailable — stats probe down');
    const disk = [...container.querySelectorAll('div')].find(
      (node) => node.textContent === 'Disk'
    )?.parentElement;
    expect(disk?.textContent).toContain('Unavailable');
    expect(disk?.textContent).not.toContain('Healthy');
    expect(text).toContain('Storage errorunavailable — disk probe down');
    expect(text).not.toContain('Totals since restart');
    expect(
      [...container.querySelectorAll('span')].some((node) => node.textContent === 'Live')
    ).toBe(false);
    unmount();
  });
});

describe('Diagnostics — ping is last-to-START-wins', () => {
  test('a slow earlier probe does not overwrite the newer reading', async () => {
    const slow = deferred<Response>();
    let pings = 0;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/ping')) {
        pings += 1;
        if (pings === 1) return slow.promise;
        return Promise.resolve(json({ ok: true, data: { pong: true } }));
      }
      return Promise.resolve(json({ ok: true, data: {} }));
    }) as typeof fetch;

    const { container, unmount } = render(createElement(Diagnostics));
    await settle(5);

    clickText(container, 'Ping'); // probe 1 — hangs
    await settle(2);
    clickText(container, 'Ping'); // probe 2 — answers immediately
    await settle(5);
    const afterFast = container.textContent ?? '';
    expect(afterFast).toContain('Ping · ');
    expect(afterFast).not.toContain('unreachable');

    // Probe 1 finally fails. Pre-fix its write landed last and replaced the
    // newer, successful reading with 'unreachable'.
    await act(async () => {
      slow.resolve(json({ ok: false, error: 'down' }, 500));
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(container.textContent).not.toContain('unreachable');
    unmount();
  });
});
