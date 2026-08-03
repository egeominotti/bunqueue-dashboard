import { useCallback, useEffect, useRef, useState } from 'react';
import { getBaseUrl, useConnectionStore } from '@/components/dashboard/stores/connectionStore';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Input, Select } from '@/components/ui/form';
import { BqError } from '@/lib/bq';
import { opaqueHttpPathSegment } from '@/lib/upstreamPaths';

type LogLevel = 'info' | 'warn' | 'error';

interface LogTarget {
  baseUrl: string;
  authorization?: string;
}

const LOG_REQUEST_TIMEOUT_MS = 30_000;

function currentLogTarget(): LogTarget {
  const { token } = useConnectionStore.getState();
  return {
    baseUrl: getBaseUrl(),
    authorization: token ? `Bearer ${token}` : undefined,
  };
}

function sameLogTarget(a: LogTarget, b: LogTarget): boolean {
  return a.baseUrl === b.baseUrl && a.authorization === b.authorization;
}

function mapLogRequestError(
  error: unknown,
  deadline: AbortSignal,
  lifecycleSignal: AbortSignal
): unknown {
  if (deadline.aborted && !lifecycleSignal.aborted) return new BqError('Request timed out', 0);
  return error;
}

async function logRequest<T>(
  target: LogTarget,
  path: string,
  init: RequestInit,
  lifecycleSignal: AbortSignal
): Promise<T | undefined> {
  const deadline = AbortSignal.timeout(LOG_REQUEST_TIMEOUT_MS);
  const signal = AbortSignal.any([lifecycleSignal, deadline]);
  const headers = new Headers(init.headers);
  if (target.authorization) headers.set('Authorization', target.authorization);
  if (init.body != null && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  let response: Response;
  try {
    signal.throwIfAborted();
    response = await fetch(`${target.baseUrl}${path}`, { ...init, headers, signal });
    signal.throwIfAborted();
  } catch (error) {
    throw mapLogRequestError(error, deadline, lifecycleSignal);
  }

  if (response.status === 204) return undefined;

  let text: string;
  try {
    text = await response.text();
    signal.throwIfAborted();
  } catch (error) {
    throw mapLogRequestError(error, deadline, lifecycleSignal);
  }

  let data: unknown;
  let invalidJson = false;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      invalidJson = true;
    }
  }

  if (!response.ok) {
    const serverMessage =
      !invalidJson && data && typeof data === 'object'
        ? (data as { error?: unknown }).error
        : undefined;
    if (response.status === 401 && typeof window !== 'undefined') {
      window.dispatchEvent(
        new window.CustomEvent('auth:required', {
          detail: {
            scope: 'server',
            auth: target.authorization,
            target: target.baseUrl,
          },
        })
      );
    }
    throw new BqError(
      typeof serverMessage === 'string' ? serverMessage : `HTTP ${response.status}`,
      response.status
    );
  }

  if (!text) return undefined;
  if (invalidJson)
    throw new BqError(`Invalid JSON response (HTTP ${response.status})`, response.status);
  if (data && typeof data === 'object' && (data as { ok?: unknown }).ok === false) {
    const serverMessage = (data as { error?: unknown }).error;
    throw new BqError(
      typeof serverMessage === 'string' ? serverMessage : 'Operation failed',
      response.status
    );
  }
  return data as T;
}

function parseLogSnapshot(value: unknown): { logs: unknown[]; count: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BqError('Invalid logs response: expected an object envelope', 200);
  }
  const envelope = value as { ok?: unknown; data?: unknown };
  if (envelope.ok !== true || !envelope.data || typeof envelope.data !== 'object') {
    throw new BqError('Invalid logs response: expected { ok: true, data }', 200);
  }
  const data = envelope.data as { logs?: unknown; count?: unknown };
  if (
    !Array.isArray(data.logs) ||
    typeof data.count !== 'number' ||
    !Number.isSafeInteger(data.count) ||
    data.count < 0
  ) {
    throw new BqError('Invalid logs response: expected logs[] and a non-negative count', 200);
  }
  return { logs: data.logs, count: data.count };
}

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
    <Card>
      <CardHeader
        title="Logs"
        action={
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-faint">{count}</span>
            <Button
              size="sm"
              variant="ghost"
              disabled={loading || busy}
              onClick={() => void load()}
            >
              Refresh
            </Button>
            <Button size="sm" variant="danger" disabled={busy || logs.length === 0} onClick={clear}>
              Clear logs
            </Button>
          </div>
        }
      />
      {error && <p className="mb-2 text-xs text-danger">{error}</p>}
      {logs.length === 0 ? (
        <p className="text-xs text-faint">No log lines recorded for this job.</p>
      ) : (
        <ol className="flex max-h-64 flex-col gap-1 overflow-auto rounded-lg bg-surface-2 p-3">
          {logs.map((line, i) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: append-only server log, stable order
              key={i}
              className="whitespace-pre-wrap break-words font-mono text-xs text-muted"
            >
              {typeof line === 'string' ? line : JSON.stringify(line)}
            </li>
          ))}
        </ol>
      )}
      <form
        className="mt-3 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const submitted = event.currentTarget.elements.namedItem(
            'job-log-message'
          ) as HTMLInputElement | null;
          const submittedLevel = event.currentTarget.elements.namedItem(
            'job-log-level'
          ) as HTMLSelectElement | null;
          void add(submitted?.value ?? message, submittedLevel?.value ?? level);
        }}
      >
        <Input
          aria-label="Log message"
          name="job-log-message"
          autoComplete="off"
          value={message}
          onInput={(e) => {
            draftRevision.current += 1;
            setMessage(e.currentTarget.value);
          }}
          placeholder="Add a log line…"
          className="h-8 flex-1 text-xs"
        />
        <Select
          aria-label="Log level"
          name="job-log-level"
          value={level}
          onChange={(e) => {
            draftRevision.current += 1;
            setLevel(e.target.value as LogLevel);
          }}
          className="h-8 w-24 text-xs"
        >
          <option value="info">info</option>
          <option value="warn">warn</option>
          <option value="error">error</option>
        </Select>
        <Button type="submit" size="sm" disabled={busy || message.trim() === ''}>
          Add
        </Button>
      </form>
    </Card>
  );
}
