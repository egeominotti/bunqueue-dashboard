import type { ServerTargetClient } from '@/lib/bq';
import type { JobFull } from '@/lib/bqTypes';
import { downloadCsv } from '@/lib/exportFile';
import type { JobStatusFilter } from './model';

export const JOB_EXPORT_LIMIT = 10_000;
const PAGE_SIZE = 100;

/**
 * The upstream API has no snapshot token, so pages describe a live queue.
 * Reject duplicates and oversized exports rather than silently emitting a
 * partial file. The caller must explain that concurrent changes can affect it.
 */
export async function collectJobsForExport(
  client: Pick<ServerTargetClient, 'jobsList'>,
  queue: string,
  status: JobStatusFilter,
  search: string,
  signal: AbortSignal
): Promise<JobFull[]> {
  const matching: JobFull[] = [];
  const seen = new Set<string>();
  const term = search.trim().toLowerCase();
  const states = status === 'all' ? undefined : [status];
  let offset = 0;
  for (;;) {
    signal.throwIfAborted();
    const limit = offset === JOB_EXPORT_LIMIT ? 1 : Math.min(PAGE_SIZE, JOB_EXPORT_LIMIT - offset);
    const { jobs } = await client.jobsList(queue, states, limit, offset);
    signal.throwIfAborted();
    if (jobs.length > limit) throw new Error('The server returned an invalid export page.');
    if (offset === JOB_EXPORT_LIMIT) {
      if (jobs.length > 0) {
        throw new Error(
          `Export exceeds ${JOB_EXPORT_LIMIT.toLocaleString()} jobs. Filter by state first.`
        );
      }
      return matching;
    }
    for (const job of jobs) {
      if (seen.has(job.id)) {
        throw new Error('The queue changed during export. Retry when it is stable.');
      }
      seen.add(job.id);
      const name = typeof job.name === 'string' ? job.name.toLowerCase() : '';
      if (!term || job.id.toLowerCase().includes(term) || name.includes(term)) {
        matching.push(job);
      }
    }
    if (jobs.length < limit) return matching;
    offset += jobs.length;
  }
}

export function downloadJobsCsv(queue: string, status: JobStatusFilter, jobs: JobFull[]) {
  const rows = jobs.map((job) => ({
    id: job.id,
    name: job.name ?? 'default',
    queue: job.queue ?? queue,
    state: job.state ?? '',
    priority: job.priority ?? 0,
    attempts: job.attempts ?? 0,
    maxAttempts: job.maxAttempts ?? '',
    createdAt: job.createdAt ? new Date(job.createdAt).toISOString() : '',
    durationMs: job.startedAt && job.completedAt ? job.completedAt - job.startedAt : '',
  }));
  downloadCsv(`jobs-${queue}-${status}`, rows, [
    'id',
    'name',
    'queue',
    'state',
    'priority',
    'attempts',
    'maxAttempts',
    'createdAt',
    'durationMs',
  ]);
}
