import { describe, expect, test } from 'bun:test';
import type { ServerTargetClient } from '../src/lib/bq';
import type { JobFull } from '../src/lib/bqTypes';
import { collectJobsForExport, JOB_EXPORT_LIMIT } from '../src/pages/control/jobsPro/exportJobs';

const job = (index: number): JobFull =>
  ({
    id: `job-${index}`,
    name: index === 234 ? 'Special Invoice' : 'standard',
    queue: 'orders',
  }) as JobFull;

describe('complete jobs export', () => {
  test('applies the ID or name filter to jobs on every page', async () => {
    const jobs = Array.from({ length: 235 }, (_, index) => job(index));
    const client = {
      jobsList: async (_queue: string, _states: string[] | undefined, limit = 50, offset = 0) => ({
        ok: true,
        jobs: jobs.slice(offset, offset + limit),
      }),
    } satisfies Pick<ServerTargetClient, 'jobsList'>;

    const result = await collectJobsForExport(
      client,
      'orders',
      'waiting',
      ' SPECIAL ',
      new AbortController().signal
    );
    expect(result.map(({ id }) => id)).toEqual(['job-234']);
  });

  test('rejects repeated jobs when the live queue changes between pages', async () => {
    const first = Array.from({ length: 100 }, (_, index) => job(index));
    const client = {
      jobsList: async (_queue: string, _states: string[] | undefined, _limit = 50, offset = 0) => ({
        ok: true,
        jobs: offset === 0 ? first : [first[0]],
      }),
    } satisfies Pick<ServerTargetClient, 'jobsList'>;

    await expect(
      collectJobsForExport(client, 'orders', 'all', '', new AbortController().signal)
    ).rejects.toThrow('queue changed during export');
  });

  test('refuses an oversized queue instead of returning a partial file', async () => {
    const client = {
      jobsList: async (_queue: string, _states: string[] | undefined, limit = 50, offset = 0) => ({
        ok: true,
        jobs: Array.from({ length: Math.min(limit, JOB_EXPORT_LIMIT + 1 - offset) }, (_, index) =>
          job(offset + index)
        ),
      }),
    } satisfies Pick<ServerTargetClient, 'jobsList'>;

    await expect(
      collectJobsForExport(client, 'orders', 'all', '', new AbortController().signal)
    ).rejects.toThrow('Export exceeds 10,000 jobs');
  });
});
