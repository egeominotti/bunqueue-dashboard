/**
 * Which job actions the server will actually accept for a given state. Shared
 * between JobInspector (single job) and JobsPro (bulk/per-row) so the two
 * surfaces never drift on what's legal to attempt.
 *
 * Mirrors the location-based gating in src/application/operations/jobManagement.ts
 * only where the upstream operation is safe for an HTTP client. `waiting-children`
 * is NOT in the runnable heap, so priority and delay are unavailable there.
 * Cancel and Discard are deliberately unavailable in every state: v2.9.3 cannot
 * inspect reverse dependencies or make either transition conditional on the state
 * that the dashboard read. Discard also bypasses terminal flow-failure resolution
 * and accepts a job that became active after the snapshot, which can strand its
 * parent while the worker continues external side effects. DLQ retry is also
 * unavailable: a read followed by retry is subject to id-reuse TOCTOU, and the
 * endpoint has no atomic generation/topology precondition. Completed requeue is
 * unavailable because v2.9.3 does not rebuild a child's dependency registration.
 *
 * Active state transitions are deliberately absent. Bunqueue v2.9.3 removes
 * the broker processing record but cannot cancel the already-running worker;
 * retry/discard/fail/move-to-delayed can therefore duplicate external side
 * effects. The dashboard only permits the non-transitioning progress update.
 */
export function actionGates(state: string | undefined) {
  const inRunQueue = state === 'waiting' || state === 'delayed' || state === 'prioritized';
  return {
    cancel: false,
    discard: false,
    promote: state === 'delayed',
    retryDlq: false,
    requeueCompleted: false,
    setPriority: inRunQueue,
    setDelay: inRunQueue,
  };
}

/** Shared by the UI and agent: the SDK does not add atomic topology guards. */
export function flowOperationError(operation: string): string | null {
  if (operation === 'updateData') {
    return 'Flow data is read-only: replacing the payload can remove dependency metadata.';
  }
  if (operation === 'retry') {
    return 'Flow retry is unavailable: Bunqueue has no atomic job-generation or state precondition.';
  }
  if (operation === 'remove' || operation === 'removeUnprocessedChildren') {
    return 'Flow removal is unavailable: Bunqueue cannot atomically protect reverse dependencies.';
  }
  return null;
}

export function assertFlowOperationAllowed(operation: string): void {
  const error = flowOperationError(operation);
  if (error) throw new Error(error);
}

export function assertFlowOperationState(operation: string, state: string): void {
  const gates = actionGates(state);
  const allowed =
    operation === 'promote'
      ? gates.promote
      : operation === 'changePriority'
        ? gates.setPriority
        : operation === 'changeDelay'
          ? gates.setDelay
          : true;
  if (!allowed) throw new Error(`Flow ${operation} is unavailable for a ${state} job.`);
}
