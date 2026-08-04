import {
  bq,
  bulkJobPayloadBudgetError,
  describe,
  expect,
  fetchHarness,
  installTestHooks,
  json,
  lastCall,
  MAX_BULK_JOB_COUNT,
  test,
} from './bq.helpers';

installTestHooks();

describe('bq request construction', () => {
  test('rejects a valid per-job data x count envelope before aggregate JSON allocation', async () => {
    // This body is below Bunqueue's 10 MiB per-job data limit. Repeating the
    // same object 10k times would otherwise ask JSON.stringify for ~97.7 GiB.
    const body = { data: { blob: 'x'.repeat(10 * 1024 * 1024 - 64) } };
    const jobs = Array.from({ length: 10_000 }, () => body);
    expect(bulkJobPayloadBudgetError(jobs)).toContain('64 MiB');

    const before = fetchHarness.calls.length;
    await expect(bq.addJobsBulk('q1', jobs)).rejects.toThrow('64 MiB');
    expect(fetchHarness.calls).toHaveLength(before);
  });

  test('rejects oversized bulk collections before validation or fragment allocation', async () => {
    const job = { data: {} };
    const jobs = Array.from({ length: MAX_BULK_JOB_COUNT + 1 }, () => job);
    const before = fetchHarness.calls.length;
    expect(bulkJobPayloadBudgetError(jobs)).toContain(`at most ${MAX_BULK_JOB_COUNT}`);
    await expect(bq.addJobsBulk('q1', jobs)).rejects.toThrow(`at most ${MAX_BULK_JOB_COUNT}`);
    expect(fetchHarness.calls).toHaveLength(before);
  });

  test('unsafe repeat shapes are rejected locally before any enqueue request', async () => {
    const before = fetchHarness.calls.length;
    await expect(
      bq.addJob('q1', {
        data: {},
        repeat: { pattern: '* * * * *' } as unknown as { every: number },
      })
    ).rejects.toThrow('pattern repeats are unsafe');
    await expect(
      bq.addJobsBulk('q1', [
        { data: {}, repeat: { every: 0 } },
        { data: {}, repeat: { every: 1000 } },
      ])
    ).rejects.toThrow('Repeat "every"');
    expect(fetchHarness.calls).toHaveLength(before);
  });

  test('single add captures guarded getters once, validates, and sends that exact body', async () => {
    const reads = { parentId: 0, repeat: 0, jobId: 0, dependsOn: 0 };
    const job = Object.defineProperties(
      { data: { exact: true } },
      {
        parentId: {
          enumerable: true,
          get: () => (++reads.parentId === 1 ? undefined : 'victim-parent'),
        },
        repeat: {
          enumerable: true,
          get: () => (++reads.repeat === 1 ? { every: 1000 } : { pattern: '* * * * *' }),
        },
        jobId: {
          enumerable: true,
          get: () => (++reads.jobId === 1 ? 'safe-id' : '..'),
        },
        dependsOn: {
          enumerable: true,
          get: () => (++reads.dependsOn === 1 ? ['safe-dep'] : ['..']),
        },
      }
    ) as import('../src/lib/bq').AddJobBody;

    fetchHarness.responder = () => json({ ok: true, id: 'safe-id' });
    await bq.addJob('q1', job);

    expect(reads).toEqual({ parentId: 1, repeat: 1, jobId: 1, dependsOn: 1 });
    expect(JSON.parse(String(lastCall().init?.body))).toEqual({
      data: { exact: true },
      repeat: { every: 1000 },
      jobId: 'safe-id',
      dependsOn: ['safe-dep'],
    });
  });

  test('single add rejects forbidden fields injected by its exact root toJSON value', async () => {
    const forbidden: unknown[] = [
      { data: {}, parentId: 'victim-parent' },
      { data: {}, continueParentOnFailure: true },
      { data: {}, repeat: { pattern: '* * * * *' } },
      { data: {}, jobId: '..' },
      { data: {}, dependsOn: ['..'] },
      { data: {}, dependsOn: 'not-an-array' },
      ['not', 'a', 'job'],
      null,
    ];

    for (const exact of forbidden) {
      let serializations = 0;
      const before = fetchHarness.calls.length;
      const job = {
        data: {},
        toJSON: () => {
          serializations += 1;
          return exact;
        },
      } as unknown as import('../src/lib/bq').AddJobBody;
      await expect(bq.addJob('q1', job)).rejects.toThrow();
      expect(serializations).toBe(1);
      expect(fetchHarness.calls).toHaveLength(before);
    }
  });

  test('unsafe bulk topology and inert compatibility fields never reach PUSHB', async () => {
    const before = fetchHarness.calls.length;
    await expect(
      bq.addJobsBulk('q1', [
        {
          data: {},
          parentId: 'victim',
          failParentOnFailure: true,
        } as unknown as import('../src/lib/bq').BulkJobBody,
      ])
    ).rejects.toThrow('Flow topology must use the atomic flow API');
    expect(fetchHarness.calls).toHaveLength(before);
  });

  test('safe interval repeats are sent unchanged', async () => {
    fetchHarness.responder = () => json({ ok: true, id: 'repeat-1' });
    await bq.addJob('q1', { data: {}, repeat: { every: 60_000, limit: 3 } });
    expect(lastCall().init?.body).toBe(
      JSON.stringify({ data: {}, repeat: { every: 60_000, limit: 3 } })
    );
  });

  test('db.rows composes paging, ordering and filter params for the agent', async () => {
    fetchHarness.responder = () => json({ ok: true, rows: [] });
    await bq.db.rows('jobs', 50, 100, 'id', 'desc', {
      column: 'state',
      op: 'eq',
      value: 'failed',
    });
    expect(lastCall().url).toBe(
      'http://localhost:6800/db/tables/jobs?limit=50&offset=100&orderBy=id&dir=desc&fcol=state&fop=eq&fval=failed'
    );
  });
});
