import type { AddJobBody } from '@/lib/bq';
import type { JobFull } from '@/lib/bqTypes';

/**
 * Payload handed to Add Job (via router state) when cloning an existing job, so
 * the operator can tweak the data/options and enqueue a FRESH job while the
 * original record stays intact for audit. Distinct from retry/requeue, which
 * re-run the same job with its original payload.
 */
export interface CloneJobState {
  clone: {
    queue: string;
    /** Pretty-printed JSON of the source job's data, ready for the textarea. */
    dataText: string;
    options: Partial<
      Pick<
        AddJobBody,
        'priority' | 'maxAttempts' | 'backoff' | 'timeout' | 'removeOnComplete' | 'removeOnFail'
      >
    >;
  };
}

/** Build the router-state clone payload from a loaded job (options carried when present). */
export function buildCloneState(job: JobFull): CloneJobState {
  const options: CloneJobState['clone']['options'] = {};
  if (typeof job.priority === 'number') options.priority = job.priority;
  if (typeof job.maxAttempts === 'number') options.maxAttempts = job.maxAttempts;
  if (typeof job.backoff === 'number') options.backoff = job.backoff;
  if (typeof job.timeout === 'number') options.timeout = job.timeout;
  if (typeof job.removeOnComplete === 'boolean') options.removeOnComplete = job.removeOnComplete;
  if (typeof job.removeOnFail === 'boolean') options.removeOnFail = job.removeOnFail;
  return {
    clone: {
      queue: job.queue ?? '',
      dataText: JSON.stringify(job.data ?? {}, null, 2),
      options,
    },
  };
}
