import { Card, CardHeader } from '@/components/ui/Card';
import type { JobFull } from '@/lib/bqTypes';
import { formatDuration } from '@/lib/format';

/** Mirrors the server's calculateBackoff (src/domain/types/job.ts) sans jitter. */
const DEFAULT_MAX_BACKOFF = 3_600_000;
const MAX_ROWS = 10;

/**
 * First attempt a backoff delay applies to. Backoff gates RETRIES, not the
 * first execution — a never-run job (made=0) starts at attempt 2, i.e. k=1.
 */
export const firstRetryIndex = (made: number) => Math.max(made, 1);

/** Rows previewDelays would produce without the MAX_ROWS cap. */
export function remainingRetries(job: JobFull): number {
  return Math.max(0, (job.maxAttempts ?? 0) - firstRetryIndex(job.attempts ?? 0));
}

export function previewDelays(job: JobFull): { attempt: number; delayMs: number }[] {
  const maxAttempts = job.maxAttempts ?? 0;
  const made = job.attempts ?? 0;
  const cfg = job.backoffConfig;
  const maxDelay = cfg?.maxDelay ?? DEFAULT_MAX_BACKOFF;
  const base = cfg?.delay ?? job.backoff ?? 1000;
  const rows: { attempt: number; delayMs: number }[] = [];
  // Backoff applies before RETRIES, not the first attempt. A never-run job
  // (made=0) must start at attempt 2 — its first execution has no backoff
  // delay, only the job's own `delay` option gates it.
  for (let k = firstRetryIndex(made); k < maxAttempts && rows.length < MAX_ROWS; k++) {
    const raw = cfg?.type === 'fixed' ? base : base * 2 ** k;
    rows.push({ attempt: k + 1, delayMs: Math.min(raw, maxDelay) });
  }
  return rows;
}

/** Preview of the retry-delay schedule for a job's remaining attempts. */
export function JobBackoff({ job }: { job: JobFull }) {
  const maxAttempts = job.maxAttempts ?? 0;
  const made = job.attempts ?? 0;

  if (maxAttempts <= 1) {
    return (
      <Card>
        <CardHeader title="Backoff" />
        <p className="text-xs text-faint">
          No retries configured (max attempts = {maxAttempts || 1}).
        </p>
      </Card>
    );
  }

  if (made >= maxAttempts) {
    return (
      <Card>
        <CardHeader title="Backoff schedule" />
        <p className="text-xs text-faint">
          Max attempts reached — no further retries will be scheduled.
        </p>
      </Card>
    );
  }

  const cfg = job.backoffConfig;
  const typeLabel = cfg ? cfg.type : 'exponential (default)';
  // Count the rows that WOULD exist uncapped, from the same start index the
  // preview loop uses — `maxAttempts - made` overstates it by one for a
  // never-run job, whose first execution has no backoff row.
  const remaining = remainingRetries(job);
  const rows = previewDelays(job);

  return (
    <Card>
      <CardHeader
        title="Backoff schedule"
        action={
          <span className="text-xs capitalize text-faint">
            {typeLabel}
            {cfg?.maxDelay ? ` · cap ${formatDuration(cfg.maxDelay)}` : ''}
          </span>
        }
      />
      <ul className="flex flex-col gap-1.5">
        {rows.map((r) => (
          <li key={r.attempt} className="flex items-center justify-between text-sm">
            <span className="text-muted">
              Attempt {r.attempt} / {maxAttempts}
            </span>
            <span className="font-mono text-xs text-fg">~{formatDuration(r.delayMs)}</span>
          </li>
        ))}
      </ul>
      {remaining > MAX_ROWS && (
        <p className="mt-2 text-[11px] text-faint">
          Showing next {MAX_ROWS} of {remaining} remaining attempts.
        </p>
      )}
      <p className="mt-2 text-[11px] text-faint">
        Approximate — the server applies ±{cfg?.type === 'fixed' ? '20' : '50'}% jitter at retry
        time, capped at {formatDuration(cfg?.maxDelay ?? DEFAULT_MAX_BACKOFF)}.
      </p>
    </Card>
  );
}
