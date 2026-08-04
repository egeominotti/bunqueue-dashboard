import {
  act,
  configSig,
  describe,
  expect,
  installTestHooks,
  json,
  renderHook,
  selectionLabel,
  test,
  useSyncedConfig,
  walkFlow,
  withoutActed,
} from './job-queue-pages-fixes.helpers';

installTestHooks();

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
