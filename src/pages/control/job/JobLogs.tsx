import { useCallback, useEffect, useRef, useState } from 'react';
import { getBaseUrl, useConnectionStore } from '@/components/dashboard/stores/connectionStore';
import { BqError } from '@/lib/bq';
import { opaqueHttpPathSegment } from '@/lib/upstreamPaths';
import { JobLogsView } from './JobLogsView';
import {
  currentLogTarget,
  type LogLevel,
  type LogTarget,
  logRequest,
  parseLogSnapshot,
  sameLogTarget,
} from './jobLogsTransport';

/**
 * Job logs viewer + writer. Reads `GET /jobs/:id/logs` (bq.jobLogs), appends
 * lines via `POST /jobs/:id/logs` (bq.addJobLog) and wipes them via
 * `DELETE /jobs/:id/logs` (bq.clearJobLogs). Every mutation reloads the list so
 * the view never drifts from the server.
 */
export function JobLogs({ jobId }: { jobId: string }) {
  const connectionBaseUrl = useConnectionStore((state) => state.baseUrl);
  const connectionToken = useConnectionStore((state) => state.token);
  const [logs, setLogs] = useState<unknown[]>([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [level, setLevel] = useState<LogLevel>('info');
  const [busy, setBusy] = useState(false);

  // State alone cannot close React's same-tick click window. These refs are the
  // operation mutexes and generation ownership for reads and non-idempotent
  // writes. Aborts save work; generations remain the correctness backstop for
  // fetch doubles (and transports) that ignore AbortSignal.
  const mounted = useRef(false);
  const activeJobId = useRef<string | null>(null);
  const loadGen = useRef(0);
  const loadAbort = useRef<AbortController | null>(null);
  const mutationGen = useRef(0);
  const mutationAbort = useRef<AbortController | null>(null);
  const mutationBusy = useRef(false);
  // Track edits to the whole add-form draft independently of its values.
  // Equality is not enough: editing and restoring the submitted text/level is
  // still a newer draft and must not be erased by an older POST completing.
  const draftRevision = useRef(0);

  useEffect(() => {
    mounted.current = true;
    activeJobId.current = jobId;

    const invalidateForTargetChange = () => {
      loadGen.current += 1;
      loadAbort.current?.abort();
      loadAbort.current = null;
      mutationGen.current += 1;
      mutationAbort.current?.abort();
      mutationAbort.current = null;
      mutationBusy.current = false;
      draftRevision.current += 1;
      setLogs([]);
      setCount(0);
      setLoading(false);
      setError(null);
      setMessage('');
      setBusy(false);
    };

    // Zustand subscriptions run synchronously with setState, before an old
    // request continuation can publish under a newly selected server/token.
    const unsubscribe = useConnectionStore.subscribe((next, previous) => {
      if (next.baseUrl === previous.baseUrl && next.token === previous.token) return;
      invalidateForTargetChange();
    });

    // A reused component with a new job id is a new lifecycle too. Clear any
    // previous job's rows before the auto-load below starts.
    invalidateForTargetChange();

    return () => {
      mounted.current = false;
      activeJobId.current = null;
      unsubscribe();
      loadGen.current += 1;
      loadAbort.current?.abort();
      loadAbort.current = null;
      mutationGen.current += 1;
      mutationAbort.current?.abort();
      mutationAbort.current = null;
      mutationBusy.current = false;
    };
  }, [jobId]);

  const load = useCallback(
    async (options?: { acceptedLabel?: string; target?: LogTarget }): Promise<boolean> => {
      loadAbort.current?.abort();
      const controller = new AbortController();
      loadAbort.current = controller;
      const my = ++loadGen.current;

      // Normally the reactive render snapshot is current. If an event from an
      // old render is delivered during a connection transition, fall back to a
      // fresh snapshot instead of ever pairing a new host with an old token.
      const store = useConnectionStore.getState();
      const target =
        options?.target ??
        (store.baseUrl === connectionBaseUrl && store.token === connectionToken
          ? {
              baseUrl: getBaseUrl(),
              authorization: connectionToken ? `Bearer ${connectionToken}` : undefined,
            }
          : currentLogTarget());
      const isCurrent = () =>
        mounted.current &&
        activeJobId.current === jobId &&
        my === loadGen.current &&
        !controller.signal.aborted &&
        sameLogTarget(target, currentLogTarget());

      setLoading(true);
      setError(null);
      try {
        const response = await logRequest<unknown>(
          target,
          `/jobs/${opaqueHttpPathSegment(jobId)}/logs`,
          {},
          controller.signal
        );
        const snapshot = parseLogSnapshot(response);
        if (!isCurrent()) return false;
        setLogs(snapshot.logs);
        setCount(snapshot.count);
        return true;
      } catch (cause) {
        if (!isCurrent()) return false;
        const detail = cause instanceof Error ? cause.message : String(cause);
        setError(
          options?.acceptedLabel
            ? `${options.acceptedLabel} succeeded, but couldn't reload logs: ${detail}`
            : detail
        );
        return false;
      } finally {
        if (my === loadGen.current) {
          if (loadAbort.current === controller) loadAbort.current = null;
          if (mounted.current) setLoading(false);
        }
      }
    },
    [jobId, connectionBaseUrl, connectionToken]
  );

  useEffect(() => {
    void load();
  }, [load]);

  const mutate = async (
    init: RequestInit,
    acceptedLabel: string,
    onAccepted: () => void
  ): Promise<void> => {
    if (mutationBusy.current) return;
    mutationBusy.current = true;
    const controller = new AbortController();
    mutationAbort.current = controller;
    const my = ++mutationGen.current;
    const target = currentLogTarget();

    // A snapshot started before this write cannot authoritatively land after
    // it. Invalidate it before issuing the mutation, even if abort is ignored.
    loadGen.current += 1;
    loadAbort.current?.abort();
    loadAbort.current = null;
    setLoading(false);
    setBusy(true);
    setError(null);

    const isCurrent = () =>
      mounted.current &&
      activeJobId.current === jobId &&
      my === mutationGen.current &&
      !controller.signal.aborted &&
      sameLogTarget(target, currentLogTarget());

    try {
      const accepted = await logRequest<unknown>(
        target,
        `/jobs/${opaqueHttpPathSegment(jobId)}/logs`,
        init,
        controller.signal
      );
      if (
        !accepted ||
        typeof accepted !== 'object' ||
        Array.isArray(accepted) ||
        (accepted as { ok?: unknown }).ok !== true
      ) {
        throw new BqError('Invalid log mutation response: expected { ok: true }', 200);
      }
      if (!isCurrent()) return;
      onAccepted();
      // load() owns read-back errors. Keeping them outside this mutation catch
      // prevents an accepted non-idempotent write from being presented as a
      // failed write and retried by the operator.
      await load({ acceptedLabel, target });
    } catch (cause) {
      if (isCurrent()) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (my === mutationGen.current) {
        mutationBusy.current = false;
        if (mutationAbort.current === controller) mutationAbort.current = null;
        if (mounted.current) setBusy(false);
      }
    }
  };

  const add = async (submittedMessage = message, submittedLevel: string = level) => {
    if (mutationBusy.current) return;
    // Read the submitted form value, not only the last committed React render:
    // Enter can submit in the same browser task as the final input event.
    const text = submittedMessage.trim();
    if (!text) return;
    const safeLevel: LogLevel =
      submittedLevel === 'warn' || submittedLevel === 'error' ? submittedLevel : 'info';
    const submittedDraftRevision = draftRevision.current;
    // Keep the actual submitted DOM snapshot controlled by React while the
    // request is pending. If the final input event and submit share one task,
    // the busy render must not erase a draft that the server later rejects.
    setMessage(submittedMessage);
    setLevel(safeLevel);
    await mutate(
      { method: 'POST', body: JSON.stringify({ message: text, level: safeLevel }) },
      'Log addition',
      () => {
        if (draftRevision.current === submittedDraftRevision) setMessage('');
      }
    );
  };

  const clear = async () => {
    if (mutationBusy.current) return;
    if (!window.confirm('Clear all logs for this job?')) return;
    await mutate({ method: 'DELETE' }, 'Log clearing', () => {
      setLogs([]);
      setCount(0);
    });
  };

  return (
    <JobLogsView
      logs={logs}
      count={count}
      loading={loading}
      busy={busy}
      error={error}
      message={message}
      level={level}
      draftRevision={draftRevision}
      setMessage={setMessage}
      setLevel={setLevel}
      load={() => void load()}
      clear={() => void clear()}
      add={(submittedMessage, submittedLevel) => void add(submittedMessage, submittedLevel)}
    />
  );
}
