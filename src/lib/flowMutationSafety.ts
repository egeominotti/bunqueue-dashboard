import type { JobFull } from './bqTypes';

export const FLOW_DELETION_UNAVAILABLE =
  'Unavailable in Bunqueue v2.9.0: the server cannot inspect reverse flow dependencies or delete/discard topology atomically.';

export const FLOW_BULK_RETRY_UNAVAILABLE =
  'DLQ retry is unavailable in Bunqueue v2.9.0: its GET and retry POST have no atomic job-generation, state, or flow-topology precondition.';

export const FLOW_DLQ_RETRY_UNAVAILABLE = FLOW_BULK_RETRY_UNAVAILABLE;

export const FLOW_COMPLETED_REQUEUE_UNAVAILABLE =
  'Completed-job requeue is unavailable in Bunqueue v2.9.0 because retry-completed re-inserts a child without rebuilding its flow dependency registration.';

export const FLOW_DLQ_RETENTION_UNAVAILABLE =
  'DLQ max age and max entries are read-only: changing them can expire or immediately evict a flow child without an atomic reverse-dependency check.';

/**
 * Compatibility helper for callers that used the former two-request topology
 * check. No snapshot can make the subsequent POST safe: a concurrent purge and
 * recreation may give the same id to a different flow generation.
 */
export function standaloneDlqRetryError(
  _job: JobFull | null | undefined,
  _expectedQueue: string,
  _expectedId: string
): string {
  return FLOW_DLQ_RETRY_UNAVAILABLE;
}

/** Defense in depth for stale imports: never issue the non-atomic retry POST. */
export function retryStandaloneDlqJob(_queue: string, _jobId: string): Promise<never> {
  throw new TypeError(FLOW_DLQ_RETRY_UNAVAILABLE);
}
