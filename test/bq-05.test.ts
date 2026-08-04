import {
  type BulkJobBody,
  bq,
  bulkJobPayloadBudgetError,
  captureServerRequestTarget,
  createServerTargetClient,
  describe,
  expect,
  fetchHarness,
  installTestHooks,
  json,
  lastCall,
  test,
} from './bq.helpers';

installTestHooks();

describe('bq request construction', () => {
  test('sends the same bounded toJSON serialization measured by the core request pass', async () => {
    let serializations = 0;
    const job = {
      data: {
        toJSON: () => ({ pass: ++serializations }),
      },
    };

    // Simulate AddJob/BulkAddJobs' allocation-light UI preflight. The core
    // pass may observe a different value, but it must send exactly that second
    // representation without invoking toJSON a third time.
    expect(bulkJobPayloadBudgetError([job], 1024)).toBeNull();
    fetchHarness.responder = () => json({ ok: true, ids: ['j1'] });
    await bq.addJobsBulk('q1', [job]);

    expect(serializations).toBe(2);
    expect(JSON.parse(String(lastCall().init?.body))).toEqual({
      jobs: [{ data: { pass: 2 } }],
    });
  });

  test('reads a mutable bulk-job getter once and sends the captured value', async () => {
    let getterReads = 0;
    const job = Object.defineProperty({}, 'data', {
      enumerable: true,
      get: () => ({ read: ++getterReads }),
    }) as import('../src/lib/bq').BulkJobBody;

    fetchHarness.responder = () => json({ ok: true, ids: ['j1'] });
    await bq.addJobsBulk('q1', [job]);

    expect(getterReads).toBe(1);
    expect(JSON.parse(String(lastCall().init?.body))).toEqual({
      jobs: [{ data: { read: 1 } }],
    });
  });

  test('captures guarded getters once, then validates and sends that same representation', async () => {
    const reads = { parentId: 0, repeat: 0, jobId: 0, dependsOn: 0 };
    const job = Object.defineProperties(
      { data: { ok: true } },
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
          get: () => (++reads.dependsOn === 1 ? ['dep-safe'] : ['..']),
        },
      }
    ) as BulkJobBody;

    fetchHarness.responder = () => json({ ok: true, ids: ['safe-id'] });
    await bq.addJobsBulk('q1', [job]);

    expect(reads).toEqual({ parentId: 1, repeat: 1, jobId: 1, dependsOn: 1 });
    expect(JSON.parse(String(lastCall().init?.body))).toEqual({
      jobs: [
        {
          data: { ok: true },
          repeat: { every: 1000 },
          dependsOn: ['dep-safe'],
          customId: 'safe-id',
        },
      ],
    });
  });

  test('both bulk clients reject forbidden fields injected by the exact JSON representation', async () => {
    const targetClient = createServerTargetClient(captureServerRequestTarget());
    const forbidden: Array<Record<string, unknown>> = [
      { parentId: 'victim-parent' },
      { continueParentOnFailure: true },
      { repeat: { pattern: '* * * * *' } },
      { jobId: 'wrong-domain-spelling' },
      { dependsOn: ['..'] },
    ];
    const clients = [
      (jobs: BulkJobBody[]) => bq.addJobsBulk('q1', jobs),
      (jobs: BulkJobBody[]) => targetClient.addJobsBulk('q1', jobs),
    ];

    for (const invoke of clients) {
      for (const injected of forbidden) {
        const before = fetchHarness.calls.length;
        const job = {
          data: {},
          toJSON: () => ({ data: { exact: true }, ...injected }),
        } as unknown as BulkJobBody;
        await expect(invoke([job])).rejects.toThrow();
        expect(fetchHarness.calls).toHaveLength(before);
      }
    }
  });

  test('serializes every repeated reference occurrence once without a size-cache mismatch', async () => {
    let serializations = 0;
    const job = {
      data: {
        toJSON: () => ({ occurrence: ++serializations }),
      },
    };

    fetchHarness.responder = () => json({ ok: true, ids: ['j1', 'j2'] });
    await bq.addJobsBulk('q1', [job, job]);

    expect(serializations).toBe(2);
    expect(JSON.parse(String(lastCall().init?.body))).toEqual({
      jobs: [{ data: { occurrence: 1 } }, { data: { occurrence: 2 } }],
    });
  });

  test('target-client bulk enqueue also sends its single measured serialization pass', async () => {
    let serializations = 0;
    const client = createServerTargetClient(captureServerRequestTarget());
    const job = {
      data: {
        toJSON: () => ({ pass: ++serializations }),
      },
    };

    fetchHarness.responder = () => json({ ok: true, ids: ['j1'] });
    await client.addJobsBulk('q1', [job]);

    expect(serializations).toBe(1);
    expect(JSON.parse(String(lastCall().init?.body))).toEqual({
      jobs: [{ data: { pass: 1 } }],
    });
  });
});
