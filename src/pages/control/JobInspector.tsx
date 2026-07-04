import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Button, IconButton } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { CopyButton } from '@/components/ui/CopyButton';
import { EmptyState, LoadingState } from '@/components/ui/feedback';
import { Select } from '@/components/ui/form';
import { IconDownload, IconSearch } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { BqError, bq } from '@/lib/bq';
import type { JobFull } from '@/lib/bqTypes';
import { buildCloneState } from '@/lib/cloneJob';
import { downloadJson } from '@/lib/exportFile';
import { formatDateTime, formatDuration } from '@/lib/format';
import { JobActionsPanel } from './job/JobActionsPanel';
import { JobBackoff } from './job/JobBackoff';
import { JobChildren } from './job/JobChildren';
import { JobDataEditor } from './job/JobDataEditor';
import { JobLogs } from './job/JobLogs';
import { JobTimeline } from './job/JobTimeline';

type LookupMode = 'id' | 'custom';

/** Most recent failure message + which attempt it happened on, from the timeline. */
function lastError(job: JobFull): { message: string; attempt?: number; timestamp?: number } | null {
  const timeline = job.timeline ?? [];
  for (let i = timeline.length - 1; i >= 0; i--) {
    const e = timeline[i];
    if (e.state === 'failed' && e.error) {
      return { message: e.error, attempt: e.attempt, timestamp: e.timestamp };
    }
  }
  return null;
}

export function JobInspector() {
  const [params, setParams] = useSearchParams();
  const [idInput, setIdInput] = useState(params.get('id') ?? '');
  const [lookupBy, setLookupBy] = useState<LookupMode>('id');
  const [job, setJob] = useState<JobFull | null>(null);
  const [result, setResult] = useState<{ fetched: boolean; value: unknown }>({
    fetched: false,
    value: undefined,
  });
  const [loading, setLoading] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // Sequence guard (last-to-start wins): Enter can fire concurrent lookups and
  // without it the slower response would clobber the newer one.
  const lookupGen = useRef(0);

  const lookup = async (raw: string, mode: LookupMode = lookupBy, keepMsg = false) => {
    const key = raw.trim();
    if (!key) return;
    const my = ++lookupGen.current;
    setLoading(true);
    setNotFound(false);
    // After an action, act() has just set its success message — clearing it here
    // would destroy it before it ever paints.
    if (!keepMsg) setMsg(null);
    try {
      const jobRes = await (mode === 'custom' ? bq.jobByCustomId(key) : bq.job(key));
      const loaded = jobRes.job;
      // A 200 with no `job` (e.g. a custom id that resolves to nothing) is a
      // not-found, not a crash: without this guard `loaded.state` below throws.
      if (!loaded) {
        if (my !== lookupGen.current) return;
        setJob(null);
        setResult({ fetched: false, value: undefined });
        setNotFound(true);
        setParams({}, { replace: true });
        return;
      }
      // Result is keyed by the resolved internal id — for a custom-id lookup we
      // only learn it once the job comes back — so fetch it after, best-effort.
      // Only completed jobs have a stored result (the Result card renders only for
      // 'completed'), so skip the request for any other state.
      const resultRes =
        loaded.state === 'completed' ? await bq.jobResult(loaded.id).catch(() => null) : null;
      if (my !== lookupGen.current) return;
      setJob(loaded);
      setIdInput(mode === 'custom' ? loaded.id : key);
      setParams({ id: loaded.id }, { replace: true });
      setResult(
        resultRes
          ? { fetched: true, value: resultRes.result }
          : { fetched: false, value: undefined }
      );
    } catch (e) {
      if (my !== lookupGen.current) return;
      // A missing job is a real 404 or an HTTP-200 `{ok:false, error:"...not
      // found..."}` (bq.call throws BqError for both — status 200 for the
      // latter); everything else is a connection/server problem.
      if (e instanceof BqError && (e.status === 404 || /not found/i.test(e.message))) {
        setJob(null);
        setResult({ fetched: false, value: undefined });
        setNotFound(true);
        // Clear the stale URL param too — otherwise the deep-link effect sees
        // idParam !== job?.id and silently re-fetches the PREVIOUS job,
        // replacing "Job not found" (and the user's typed input) with old data.
        setParams({}, { replace: true });
      } else {
        // Network error / 5xx: the server being unreachable is not "job
        // removed" — keep whatever is loaded and surface the real error.
        setMsg({ ok: false, text: (e as Error).message });
      }
    } finally {
      if (my === lookupGen.current) setLoading(false);
    }
  };

  const idParam = params.get('id');
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run only when the URL id or the loaded job changes, not on every lookup() identity change
  useEffect(() => {
    // Deep-links always carry an internal id — force id-mode regardless of toggle.
    if (idParam && idParam !== job?.id) lookup(idParam, 'id');
  }, [idParam, job?.id]);

  const act = async (label: string, fn: () => Promise<unknown>, confirmMsg?: string) => {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    if (!job) return;
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg({ ok: true, text: `${label} ✓` });
      if (label === 'Cancel') {
        setJob(null);
        setResult({ fetched: false, value: undefined });
        // Clear the URL param too — otherwise the deep-link effect immediately
        // re-fetches the just-deleted job and replaces "Cancel ✓" with
        // "Job not found".
        setParams({}, { replace: true });
      } else {
        await lookup(job.id, 'id', true);
      }
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const state = job?.state;
  const err = job ? lastError(job) : null;
  const hasStack = (job?.stacktrace?.length ?? 0) > 0;
  const hasChildren = (job?.childrenIds?.length ?? 0) > 0;
  // Failure-first: for a failed (DLQ'd) job the error IS the story — render it
  // above Data/Result instead of burying it below the payload.
  const failureFirst = state === 'failed';
  const errorCard =
    job && (err || hasStack) ? (
      <Card>
        <CardHeader title="Error" />
        {err && (
          <div className="mb-3">
            <p className="text-sm text-danger">{err.message}</p>
            <p className="mt-1 text-[11px] text-faint">
              {err.attempt != null ? `Attempt ${err.attempt} · ` : ''}
              {formatDateTime(err.timestamp)}
            </p>
          </div>
        )}
        {hasStack && (
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-2 p-3 font-mono text-xs text-danger/90">
            {job.stacktrace?.join('\n')}
          </pre>
        )}
      </Card>
    ) : null;

  return (
    <div>
      <PageHeader
        title="Job Inspector"
        description="Look up any job by ID and drive its full lifecycle."
        actions={
          job ? (
            <>
              {(hasChildren || job.parentId) && (
                <Link
                  to={`/flows?root=${encodeURIComponent(job.id)}`}
                  className="rounded-lg border border-line px-3 py-1.5 text-sm text-muted hover:bg-surface-2 hover:text-fg"
                >
                  View flow
                </Link>
              )}
              <Link
                to="/add-job"
                state={buildCloneState(job)}
                title="Enqueue a new job pre-filled from this one"
                className="rounded-lg border border-line px-3 py-1.5 text-sm text-muted hover:bg-surface-2 hover:text-fg"
              >
                Clone
              </Link>
              <Button
                size="sm"
                onClick={() =>
                  downloadJson(
                    `job-${job.id}`,
                    result.fetched ? { ...job, result: result.value } : job
                  )
                }
              >
                <IconDownload className="size-3.5" /> Download JSON
              </Button>
            </>
          ) : undefined
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <Select
          value={lookupBy}
          aria-label="Lookup mode"
          onChange={(e) => setLookupBy(e.target.value as LookupMode)}
          className="w-40"
        >
          <option value="id">By job ID</option>
          <option value="custom">By custom ID</option>
        </Select>
        <div className="relative min-w-56 flex-1">
          <IconSearch className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
          <input
            value={idInput}
            aria-label={lookupBy === 'custom' ? 'Custom job ID' : 'Job ID'}
            onChange={(e) => setIdInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && lookup(idInput)}
            placeholder={
              lookupBy === 'custom'
                ? 'custom / idempotency id — Enter to look up'
                : 'job id (UUID) — Enter to look up'
            }
            className="h-9 w-full rounded-lg border border-line bg-surface pl-9 pr-3 font-mono text-sm text-fg placeholder:text-faint focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
        </div>
        <Button variant="accent" disabled={loading} onClick={() => lookup(idInput)}>
          Look up
        </Button>
      </div>

      {msg && (
        <div
          role="status"
          className={msg.ok ? 'mb-4 text-sm text-success' : 'mb-4 text-sm text-danger'}
        >
          {msg.text}
        </div>
      )}

      {loading && !job ? (
        <LoadingState label="Loading job…" />
      ) : notFound ? (
        <EmptyState title="Job not found" hint="Check the ID, or the job may have been removed." />
      ) : !job ? (
        <EmptyState title="No job loaded" hint="Enter a job ID above to inspect it." />
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <div className="flex flex-col gap-6 lg:col-span-2">
            <Card>
              <div className="mb-4 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-1">
                    <div className="truncate font-mono text-sm text-fg">{job.id}</div>
                    <CopyButton value={job.id} />
                  </div>
                  <div className="mt-1 font-mono text-xs text-faint">{job.queue}</div>
                </div>
                <StatusBadge status={state ?? 'waiting'} />
              </div>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
                <Kv k="Priority" v={String(job.priority ?? 0)} />
                <Kv k="Attempts" v={`${job.attempts ?? 0} / ${job.maxAttempts ?? '?'}`} />
                <Kv k="Progress" v={`${job.progress ?? 0}%`} />
                <Kv k="Created" v={formatDateTime(job.createdAt)} />
                <Kv k="Started" v={formatDateTime(job.startedAt ?? undefined)} />
                <Kv k="Completed" v={formatDateTime(job.completedAt ?? undefined)} />
                <Kv
                  k="Duration"
                  v={formatDuration(
                    job.startedAt && job.completedAt ? job.completedAt - job.startedAt : undefined
                  )}
                />
                <div>
                  <dt className="text-[11px] uppercase tracking-wider text-faint">Custom ID</dt>
                  <dd className="flex items-center gap-1 text-fg">
                    <span className="truncate font-mono">{job.customId ?? '—'}</span>
                    {job.customId && <CopyButton value={job.customId} />}
                  </dd>
                </div>
              </dl>
            </Card>

            {failureFirst && errorCard}

            <JobDataEditor
              data={job.data}
              busy={busy}
              onSave={(parsed) => act('Data', () => bq.updateJobData(job.id, parsed))}
            />

            {state === 'completed' && (
              <Card>
                <CardHeader
                  title="Result"
                  action={
                    result.fetched && result.value !== undefined && result.value !== null ? (
                      <JsonToolbar value={result.value} filename={`job-${job.id}-result`} />
                    ) : undefined
                  }
                />
                {result.fetched && result.value !== undefined && result.value !== null ? (
                  <Json value={result.value} />
                ) : (
                  <p className="text-xs text-faint">No result stored for this job.</p>
                )}
              </Card>
            )}

            {!failureFirst && errorCard}

            <JobLogs key={`logs-${job.id}`} jobId={job.id} />
            {hasChildren && <JobChildren key={`children-${job.id}`} jobId={job.id} />}
            <JobTimeline timeline={job.timeline} />
            <JobBackoff job={job} />
          </div>

          {/* On mobile the single column stacks in source order — pull the
              actions up so they sit right under the header, not below every
              read-only card. lg restores the right-rail position. */}
          <div className="order-first lg:order-none">
            <JobActionsPanel job={job} busy={busy} act={act} />
          </div>
        </div>
      )}
    </div>
  );
}

function Kv({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wider text-faint">{k}</dt>
      <dd className="text-fg">{v}</dd>
    </div>
  );
}

function Json({ value }: { value: unknown }) {
  return (
    <pre className="max-h-64 overflow-auto rounded-lg bg-surface-2 p-3 font-mono text-xs text-muted">
      {JSON.stringify(value ?? null, null, 2)}
    </pre>
  );
}

/** Copy + download controls for a JSON blob, shown in a card header. */
function JsonToolbar({ value, filename }: { value: unknown; filename: string }) {
  return (
    <div className="flex items-center gap-1">
      <CopyButton value={JSON.stringify(value ?? null, null, 2)} />
      <IconButton
        aria-label="Download JSON"
        title="Download JSON"
        onClick={() => downloadJson(filename, value ?? null)}
      >
        <IconDownload className="size-3.5" />
      </IconButton>
    </div>
  );
}
