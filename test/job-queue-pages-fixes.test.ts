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
import { previewDelays, remainingRetries } from '../src/pages/control/job/JobBackoff';
import { JobLogs } from '../src/pages/control/job/JobLogs';
import { configSig, useSyncedConfig } from '../src/pages/control/queue/ConfigForms';
import { cleanArgs } from '../src/pages/control/queue/QueueActions';
import { duplicateKeys } from '../src/pages/control/server/EnvVarsEditor';
import { ensureDom, renderHook, settle } from './domSetup';

// Regression tests for the "job-queue-pages" audit package: honest reporting of
// failed sub-fetches (Flows), last-to-START-wins sequencing (JobLogs, Diagnostics
// ping), confirm-text/request agreement (Clean), the save-vs-poll baseline race
// (ConfigForms) and two off-by-one/pluralization readouts.

const realFetch = globalThis.fetch;

beforeEach(() => {
  ensureDom();
  useConnectionStore.setState({ baseUrl: 'http://srv', token: '', agentToken: '' });
});

afterEach(() => {
  globalThis.fetch = realFetch;
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
});

describe('Flows — a failed job fetch is reported, not hidden', () => {
  test('walkFlow counts nodes it could not load', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/jobs/root')) {
        return json({ ok: true, job: { id: 'root', state: 'completed', childrenIds: ['b'] } });
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
        return json({ ok: true, job: { id: 'root', state: 'completed', childrenIds: ['b'] } });
      }
      return json({ ok: true, job: { id: 'b', state: 'completed' } });
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

  test('a mutation that succeeded is not reported as failed when the reload errors', async () => {
    let jobGets = 0;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? 'GET') !== 'GET') return Promise.resolve(json({ ok: true }));
      if (url.endsWith('/result')) return Promise.resolve(json({ ok: true, result: 1 }));
      jobGets += 1;
      // The post-action read-back (2nd GET) hits a proxy blip.
      if (jobGets > 1) return Promise.resolve(json({ ok: false, error: 'Failed to fetch' }, 502));
      return Promise.resolve(json({ ok: true, job }));
    }) as typeof fetch;

    const { container, unmount } = render(
      createElement(MemoryRouter, { initialEntries: ['/job?id=j1'] }, createElement(JobInspector))
    );
    await settle(10);
    clickText(container, 'Requeue');
    await settle(10);
    const text = container.textContent ?? '';
    // Pre-fix the red reload error REPLACED the success line, so the operator
    // re-ran an action the server had already accepted.
    expect(text).toContain('Requeue ✓');
    expect(text).toContain("couldn't reload");
    unmount();
  });
});

describe('JobLogs — a stale read must not undo a just-run mutation', () => {
  test('an in-flight refresh started BEFORE the clear cannot resurrect the logs', async () => {
    const slow = deferred<Response>();
    let gets = 0;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'DELETE') return Promise.resolve(json({ ok: true }));
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
    await settle(5);
    expect(container.textContent).toContain('old line');

    clickText(container, 'Refresh'); // read #2 starts, hangs
    await settle(2);
    clickText(container, 'Clear logs'); // DELETE + read #3 (fast)
    await settle(5);
    expect(container.textContent).not.toContain('old line');

    // The pre-DELETE snapshot lands now. Pre-fix it wrote last and the wiped
    // lines (and the count) reappeared with no error shown.
    await act(async () => {
      slow.resolve(json({ ok: true, data: { logs: ['old line'], count: 1 } }));
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(container.textContent).not.toContain('old line');
    window.confirm = originalConfirm;
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
