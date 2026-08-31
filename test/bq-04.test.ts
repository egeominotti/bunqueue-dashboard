import {
  bq,
  bulkJobPayloadBudgetError,
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
  test('queue paths encode valid punctuation and reject unmanageable names before fetch', async () => {
    await bq.dlq('orders:eu.1');
    expect(lastCall().url).toBe('http://srv/queues/orders%3Aeu.1/dlq?limit=100&offset=0');

    const callsBeforeInvalid = fetchHarness.calls.length;
    expect(() => bq.dlq('my/queue #1')).toThrow('Queue names may contain only');
    expect(() => bq.dlq('.')).toThrow('path traversal segment');
    expect(() => bq.dlq('..')).toThrow('path traversal segment');
    expect(fetchHarness.calls).toHaveLength(callsBeforeInvalid);
  });

  test('jobsList builds states/limit/offset query params', async () => {
    fetchHarness.responder = () => json({ ok: true, jobs: [] });
    await bq.jobsList('q1', ['waiting', 'active'], 25, 50);
    expect(lastCall().url).toBe(
      'http://srv/queues/q1/jobs/list?states=waiting%2Cactive&limit=25&offset=50'
    );
  });

  test('rate-limit and concurrency send the server-verified body shapes', async () => {
    await bq.setRateLimit('q1', 100);
    expect(lastCall().init?.method).toBe('PUT');
    expect(lastCall().init?.body).toBe(JSON.stringify({ limit: 100 }));

    await bq.setRateLimit('q1', 100, 60_000, 3_600_000);
    expect(lastCall().init?.body).toBe(
      JSON.stringify({ limit: 100, duration: 60_000, ttl: 3_600_000 })
    );

    await bq.setConcurrency('q1', 4);
    expect(lastCall().init?.body).toBe(JSON.stringify({ concurrency: 4 }));
  });

  test('v2.8.55 job-management options are preserved', async () => {
    await bq.changePriority('j1', 7, true);
    expect(lastCall().init?.body).toBe(JSON.stringify({ priority: 7, lifo: true }));

    await bq.failJob('j1', 'fatal', {
      unrecoverable: true,
      stack: ['worker.ts:12'],
    });
    expect(lastCall().init?.body).toBe(
      JSON.stringify({ error: 'fatal', unrecoverable: true, stack: ['worker.ts:12'] })
    );
  });

  test('v2.9.0 job and cron names are preserved separately from data', async () => {
    await bq.addJob('reports', {
      name: 'render-report',
      data: { name: 'customer supplied data' },
    });
    expect(lastCall().init?.body).toBe(
      JSON.stringify({ name: 'render-report', data: { name: 'customer supplied data' } })
    );

    await bq.createCron({
      name: 'nightly',
      jobName: 'render-report',
      queue: 'reports',
      schedule: '0 2 * * *',
      dedup: { ttl: 60_000, extend: true, replace: false },
      jobOptions: {
        delay: 500,
        stallTimeout: 30_000,
        removeOnComplete: true,
        removeOnFail: false,
      },
    });

    expect(lastCall().init?.body).toBe(
      JSON.stringify({
        name: 'nightly',
        jobName: 'render-report',
        queue: 'reports',
        schedule: '0 2 * * *',
        dedup: { ttl: 60_000, extend: true, replace: false },
        jobOptions: {
          delay: 500,
          stallTimeout: 30_000,
          removeOnComplete: true,
          removeOnFail: false,
        },
      })
    );
  });

  test('DLQ retry and completed requeue fail synchronously before transport', () => {
    const before = fetchHarness.calls.length;
    expect(() => bq.retryDlq('q1')).toThrow(/unavailable|disabled|flow/i);
    expect(() => bq.retryDlq('q1', 'job-9')).toThrow(/unavailable|disabled|flow/i);
    expect(() => bq.retryCompleted('q1')).toThrow(/unavailable|disabled|flow/i);
    expect(() => bq.retryCompleted('q1', 'job-9')).toThrow(/unavailable|disabled|flow/i);
    expect(fetchHarness.calls).toHaveLength(before);
  });

  test('rejects enabling DLQ auto-retry before transport', () => {
    const before = fetchHarness.calls.length;
    expect(() => bq.setDlqConfig('orders', { autoRetry: true })).toThrow(
      'DLQ auto-retry is unavailable'
    );
    expect(fetchHarness.calls).toHaveLength(before);
  });

  test('rejects unsupported DLQ retention patches before transport', () => {
    const before = fetchHarness.calls.length;
    expect(() => bq.setDlqConfig('orders', { maxAge: null })).toThrow(
      /retention|maxAge|unavailable/i
    );
    expect(() => bq.setDlqConfig('orders', { maxEntries: 10_000 })).toThrow(
      /retention|maxEntries|unavailable/i
    );
    expect(() => bq.setDlqConfig('orders', { maxAge: 60_000, maxEntries: 100 })).toThrow(
      /retention|maxAge|maxEntries|unavailable/i
    );
    expect(fetchHarness.calls).toHaveLength(before);
  });

  test('bulk jobs translate the public jobId field to the upstream customId field', async () => {
    fetchHarness.responder = () => json({ ok: true, ids: ['custom-1'] });
    await bq.addJobsBulk('q1', [{ data: { x: 1 }, jobId: 'custom-1', tags: ['audit'] }]);
    expect(lastCall().init?.body).toBe(
      JSON.stringify({ jobs: [{ data: { x: 1 }, tags: ['audit'], customId: 'custom-1' }] })
    );
  });

  test('bulk payload budget matches the exact translated UTF-8 envelope boundary', () => {
    const jobs = [
      { data: { emoji: '💥' }, jobId: 'stable-id' },
      { data: 'é', priority: 2 },
    ];
    const translated = jobs.map(({ jobId, ...job }) =>
      jobId === undefined ? job : { ...job, customId: jobId }
    );
    const exactBytes = new TextEncoder().encode(JSON.stringify({ jobs: translated })).byteLength;
    expect(bulkJobPayloadBudgetError(jobs, exactBytes)).toBeNull();
    expect(bulkJobPayloadBudgetError(jobs, exactBytes - 1)).toContain('payload exceeds');
  });
});
