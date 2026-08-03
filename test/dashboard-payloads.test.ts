import { describe, expect, test } from 'bun:test';
import {
  parseQueueSummaryPayload,
  parseWebhooksPayload,
  parseWorkersPayload,
} from '../src/lib/dashboardPayloads';

const worker = () => ({
  id: 'worker-1',
  name: 'worker',
  queues: ['orders'],
  concurrency: 4,
  hostname: 'worker.test',
  pid: 42,
  status: 'active',
  registeredAt: 1_000,
  lastSeen: 2_000,
  activeJobs: 0,
  processedJobs: 12,
  failedJobs: 1,
  currentJob: null,
  uptime: 1_000,
});

const webhook = () => ({
  id: 'hook-1',
  url: 'https://example.test/hook',
  events: ['job.completed'],
  queue: null,
  createdAt: 1_000,
  lastTriggered: null,
  successCount: 1,
  failureCount: 0,
  enabled: true,
});

describe('dashboard collection payload validation', () => {
  test('accepts every queue returned by the unpaginated v2.8.55 summary endpoint', () => {
    const queues = Array.from({ length: 10_001 }, (_, index) => ({
      name: `queue-${index}`,
      paused: false,
      counts: {
        waiting: 0,
        prioritized: 0,
        active: 0,
        completed: 0,
        failed: 0,
        delayed: 0,
      },
    }));
    expect(parseQueueSummaryPayload(queues)).toHaveLength(10_001);
  });

  test('accepts the exact Bunqueue v2.8.55 worker and webhook envelopes', () => {
    expect(
      parseWorkersPayload({ ok: true, data: { workers: [worker()] } }).data.workers
    ).toHaveLength(1);
    expect(
      parseWorkersPayload({ ok: true, data: { workers: [{ ...worker(), uptime: -60_000 }] } }).data
        .workers[0]?.uptime
    ).toBe(-60_000);
    expect(
      parseWebhooksPayload({
        ok: true,
        data: {
          webhooks: [
            {
              ...webhook(),
              url: 'https://user:password@example.test/hook',
              events: ['job.stalled', 'job.stalled'],
              queue: 'q'.repeat(257),
            },
          ],
        },
      }).data.webhooks
    ).toHaveLength(1);
    expect(
      parseWebhooksPayload({ ok: true, data: { webhooks: [webhook()] } }).data.webhooks
    ).toHaveLength(1);
  });

  test('quarantines malformed worker rows without taking down healthy inventory', () => {
    expect(
      parseWorkersPayload({
        ok: true,
        data: { workers: [worker(), { ...worker(), id: 'bad-queues', queues: null }] },
      }).data
    ).toMatchObject({ workers: [{ id: 'worker-1' }], quarantinedWorkers: [{ id: 'bad-queues' }] });
    expect(
      parseWorkersPayload({
        ok: true,
        data: { workers: [{ ...worker(), activeJobs: Number.NaN }] },
      }).data.quarantinedWorkers[0]?.reason
    ).toContain('activeJobs');
    expect(
      parseWorkersPayload({ ok: true, data: { workers: [worker(), worker()] } }).data
        .quarantinedWorkers[0]?.reason
    ).toContain('duplicate id');
    expect(() => parseWorkersPayload({ ok: true, data: { workers: 'not-an-array' } })).toThrow(
      'Malformed workers response'
    );
  });

  test('rejects malformed webhook arrays, unsafe URLs, and unknown events', () => {
    expect(() =>
      parseWebhooksPayload({
        ok: true,
        data: { webhooks: [{ ...webhook(), events: null }] },
      })
    ).toThrow('Malformed webhooks response');
    expect(() =>
      parseWebhooksPayload({
        ok: true,
        data: { webhooks: [{ ...webhook(), url: 'javascript:alert(1)' }] },
      })
    ).toThrow('Malformed webhooks response');
    expect(() =>
      parseWebhooksPayload({
        ok: true,
        data: { webhooks: [{ ...webhook(), events: ['job.future'] }] },
      })
    ).toThrow('Malformed webhooks response');
  });
});
