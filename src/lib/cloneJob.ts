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
        | 'priority'
        | 'maxAttempts'
        | 'backoff'
        | 'timeout'
        | 'removeOnComplete'
        | 'removeOnFail'
        | 'ttl'
        | 'tags'
        | 'groupId'
      >
    > & {
      /**
       * The source job's retry STRATEGY, kept alongside the numeric `backoff`
       * (which stays a plain delay for the form field) so a clone of an
       * exponential job isn't silently downgraded to a flat retry.
       */
      backoffConfig?: { type: 'fixed' | 'exponential'; delay: number };
    };
  };
}

/** Build the router-state clone payload from a loaded job (options carried when present). */
export function buildCloneState(job: JobFull): CloneJobState {
  const options: CloneJobState['clone']['options'] = {};
  if (typeof job.priority === 'number') options.priority = job.priority;
  if (typeof job.maxAttempts === 'number') options.maxAttempts = job.maxAttempts;
  if (typeof job.backoff === 'number') options.backoff = job.backoff;
  if (job.backoffConfig && typeof job.backoffConfig.delay === 'number') {
    options.backoffConfig = { type: job.backoffConfig.type, delay: job.backoffConfig.delay };
    // The strategy's own delay is the authoritative one for the form.
    if (typeof options.backoff !== 'number') options.backoff = job.backoffConfig.delay;
  }
  if (typeof job.timeout === 'number') options.timeout = job.timeout;
  if (typeof job.removeOnComplete === 'boolean') options.removeOnComplete = job.removeOnComplete;
  if (typeof job.removeOnFail === 'boolean') options.removeOnFail = job.removeOnFail;
  if (typeof job.ttl === 'number') options.ttl = job.ttl;
  if (Array.isArray(job.tags) && job.tags.length) options.tags = [...job.tags];
  if (typeof job.groupId === 'string' && job.groupId) options.groupId = job.groupId;
  return {
    clone: {
      queue: job.queue ?? '',
      dataText: JSON.stringify(job.data ?? {}, null, 2),
      options,
    },
  };
}
