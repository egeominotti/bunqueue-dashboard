/**
 * Which job actions the server will actually accept for a given state. Shared
 * between JobInspector (single job) and JobsPro (bulk/per-row) so the two
 * surfaces never drift on what's legal to attempt.
 *
 * Mirrors the location-based gating in src/application/operations/jobManagement.ts:
 * cancel/priority only act on queue-resident jobs (waiting/delayed/prioritized/
 * waiting-children); discard/delay also accept an active (processing) job;
 * promote only applies to a delayed job; a DLQ'd job ("failed") can only be
 * retried via the queue-level DLQ retry endpoint, not the generic job actions;
 * a completed job can only be requeued via the queue-level retry-completed
 * endpoint (src/application/dlqManager.ts retryCompletedJobs), which resets
 * attempts/timestamps and re-inserts it into the waiting queue.
 *
 * `fail` (force-fail via POST /jobs/:id/fail) and `moveToDelayed`
 * (POST /jobs/:id/move-to-delayed) only act on an active (processing) job —
 * fail pushes it down the retry/DLQ path, moveToDelayed parks it as delayed.
 */
export function actionGates(state: string | undefined) {
  const inQueue =
    state === 'waiting' ||
    state === 'delayed' ||
    state === 'prioritized' ||
    state === 'waiting-children';
  return {
    cancel: inQueue,
    discard: inQueue || state === 'active',
    promote: state === 'delayed',
    retryActive: state === 'active',
    retryDlq: state === 'failed',
    requeueCompleted: state === 'completed',
    setPriority: inQueue,
    setDelay: inQueue || state === 'active',
    fail: state === 'active',
    moveToDelayed: state === 'active',
  };
}
