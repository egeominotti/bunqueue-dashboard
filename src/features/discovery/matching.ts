import type { JobFull } from '@/lib/bqTypes';
import type { DiscoveryQuery } from './model';

export function matchesJob(
  job: JobFull,
  queue: string,
  query: DiscoveryQuery,
  state = job.state
): boolean {
  if (query.queue && queue !== query.queue) return false;
  if (query.state && query.state !== state) return false;
  if (
    query.minPriority !== undefined &&
    (!Number.isFinite(job.priority) || job.priority! < query.minPriority)
  )
    return false;
  if (
    query.createdAfter !== undefined &&
    (!Number.isFinite(job.createdAt) || job.createdAt! < query.createdAfter)
  )
    return false;
  if (
    query.createdBefore !== undefined &&
    (!Number.isFinite(job.createdAt) || job.createdAt! > query.createdBefore)
  )
    return false;
  const text = query.text?.trim().toLowerCase();
  if (!text) return true;
  const data =
    job.data && typeof job.data === 'object' && !Array.isArray(job.data)
      ? (job.data as Record<string, unknown>)
      : {};
  return [job.id, job.customId, job.name, queue, ...(job.tags ?? []), data.correlationId].some(
    (value) =>
      (typeof value === 'string' || typeof value === 'number') &&
      String(value).toLowerCase().includes(text)
  );
}
