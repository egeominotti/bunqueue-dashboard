import { Button, IconButton } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { CopyButton } from '@/components/ui/CopyButton';
import { EmptyState, LoadingState } from '@/components/ui/feedback';
import { IconDownload } from '@/components/ui/icons';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { bq } from '@/lib/bq';
import type { JobFull } from '@/lib/bqTypes';
import { downloadJson } from '@/lib/exportFile';
import { formatDateTime, formatDuration } from '@/lib/format';
import { JobActionsPanel } from '../job/JobActionsPanel';
import { JobBackoff } from '../job/JobBackoff';
import { JobChildren } from '../job/JobChildren';
import { JobDataEditor, jobDataReadOnlyReason } from '../job/JobDataEditor';
import { JobLogs } from '../job/JobLogs';
import { JobTimeline } from '../job/JobTimeline';
import type { JobLookup } from './createJobLookup';
import { buildStacktracePreview } from './jobValidation';
import type { InspectorResult, JobAction } from './types';

interface JobInspectorContentProps {
  job: JobFull | null;
  result: InspectorResult;
  resultError: string | null;
  loading: boolean;
  notFound: boolean;
  busy: boolean;
  lookup: JobLookup;
  act: JobAction;
}

function lastError(job: JobFull): { message: string; attempt?: number; timestamp?: number } | null {
  const timeline = job.timeline ?? [];
  for (let index = timeline.length - 1; index >= 0; index--) {
    const entry = timeline[index];
    if (entry.state === 'failed' && entry.error) {
      return { message: entry.error, attempt: entry.attempt, timestamp: entry.timestamp };
    }
  }
  if (job.failedReason) return { message: job.failedReason };
  return null;
}

export function JobInspectorContent({
  job,
  result,
  resultError,
  loading,
  notFound,
  busy,
  lookup,
  act,
}: JobInspectorContentProps) {
  if (loading && !job) return <LoadingState label="Loading job…" />;
  if (notFound) {
    return (
      <EmptyState title="Job not found" hint="Check the ID, or the job may have been removed." />
    );
  }
  if (!job) return <EmptyState title="No job loaded" hint="Enter a job ID above to inspect it." />;

  const state = job.state;
  const error = lastError(job);
  const stackPreview = job.stacktrace?.length ? buildStacktracePreview(job.stacktrace) : null;
  const hasChildren = (job.childrenIds?.length ?? 0) > 0;
  const dataReadOnlyReason = jobDataReadOnlyReason(state, job);
  // For a failed job the error is the story; show it before data and result.
  const failureFirst = state === 'failed';
  const errorCard =
    error || stackPreview ? (
      <Card>
        <CardHeader title="Error" />
        {error && (
          <div className="mb-3">
            <p className="text-sm text-danger">{error.message}</p>
            <p className="mt-1 text-[11px] text-faint">
              {error.attempt != null ? `Attempt ${error.attempt} · ` : ''}
              {formatDateTime(error.timestamp)}
            </p>
          </div>
        )}
        {stackPreview && (
          <>
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-2 p-3 font-mono text-xs text-danger/90">
              {stackPreview.text}
            </pre>
            {stackPreview.truncated && (
              <p className="mt-2 text-xs text-faint">
                Stack preview truncated ({stackPreview.displayedLines} of {stackPreview.totalLines}{' '}
                lines, 262,144 characters maximum). Download JSON for the complete stored stack.
              </p>
            )}
          </>
        )}
      </Card>
    ) : null;

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <div className="flex flex-col gap-6 lg:col-span-2">
        <JobSummary job={job} />
        {failureFirst && errorCard}

        <JobDataEditor
          key={`data-${job.id}`}
          data={job.data}
          busy={busy}
          editable={dataReadOnlyReason === null}
          readOnlyReason={dataReadOnlyReason ?? undefined}
          onSave={(parsed) => act('Data', () => bq.updateJobData(job.id, parsed))}
        />

        {state === 'completed' && (
          <ResultCard
            jobId={job.id}
            result={result}
            resultError={resultError}
            loading={loading}
            onRetry={() => lookup(job.id, 'id')}
          />
        )}

        {!failureFirst && errorCard}
        <JobLogs key={`logs-${job.id}`} jobId={job.id} />
        {hasChildren && <JobChildren key={`children-${job.id}`} jobId={job.id} />}
        <JobTimeline timeline={job.timeline} />
        <JobBackoff job={job} />
      </div>

      {/* Source order brings actions directly under the header on mobile. */}
      <div className="order-first lg:order-none">
        <JobActionsPanel job={job} busy={busy} act={act} />
      </div>
    </div>
  );
}

function JobSummary({ job }: { job: JobFull }) {
  return (
    <Card>
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1">
            <div className="truncate font-mono text-sm text-fg">{job.id}</div>
            <CopyButton value={job.id} />
          </div>
          <div className="mt-1 font-mono text-xs text-faint">{job.queue}</div>
        </div>
        <StatusBadge status={job.state ?? 'unknown'} />
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
        <KeyValue label="Priority" value={String(job.priority ?? 0)} />
        <KeyValue label="Name" value={job.name ?? 'default'} />
        <KeyValue label="Attempts" value={`${job.attempts ?? 0} / ${job.maxAttempts ?? '?'}`} />
        <KeyValue label="Progress" value={`${job.progress ?? 0}%`} />
        <KeyValue label="Created" value={formatDateTime(job.createdAt)} />
        <KeyValue label="Started" value={formatDateTime(job.startedAt ?? undefined)} />
        <KeyValue label="Completed" value={formatDateTime(job.completedAt ?? undefined)} />
        <KeyValue
          label="Duration"
          value={formatDuration(
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
  );
}

function ResultCard({
  jobId,
  result,
  resultError,
  loading,
  onRetry,
}: {
  jobId: string;
  result: InspectorResult;
  resultError: string | null;
  loading: boolean;
  onRetry: () => void;
}) {
  const hasValue = result.fetched && result.value !== undefined && result.value !== null;
  return (
    <Card>
      <CardHeader
        title="Result"
        action={
          hasValue ? (
            <JsonToolbar value={result.value} filename={`job-${jobId}-result`} />
          ) : undefined
        }
      />
      {hasValue ? (
        <Json value={result.value} />
      ) : resultError ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-xs text-danger">Couldn't load result — {resultError}</p>
          <Button size="sm" disabled={loading} onClick={onRetry}>
            Retry
          </Button>
        </div>
      ) : (
        <p className="text-xs text-faint">No result stored for this job.</p>
      )}
    </Card>
  );
}

function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wider text-faint">{label}</dt>
      <dd className="text-fg">{value}</dd>
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
