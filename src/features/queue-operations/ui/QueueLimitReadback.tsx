import type { QueueLimitSnapshot } from '../application/QueueOperationsRepository';

export function QueueLimitReadback({
  snapshot,
  loading,
  error,
}: {
  snapshot: QueueLimitSnapshot | null;
  loading: boolean;
  error: string;
}) {
  if (loading && !snapshot) {
    return <p className="text-sm text-muted">Reading broker limit state...</p>;
  }
  if (error && !snapshot) {
    return (
      <p role="alert" className="text-sm text-danger">
        {error}
      </p>
    );
  }
  if (!snapshot) return null;
  const rate = snapshot.rateLimit;
  return (
    <div>
      {error && (
        <p role="alert" className="mb-3 text-xs text-warning">
          Refresh failed. Showing the last successful limit snapshot: {error}
        </p>
      )}
      <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2 xl:grid-cols-4">
        <Fact
          label="Global rate limit"
          value={rate ? `${rate.max} / ${rate.duration} ms` : 'Not configured'}
        />
        <Fact
          label="Rate-limit TTL"
          value={snapshot.rateLimitTtl === -2 ? 'No active limit' : `${snapshot.rateLimitTtl} ms`}
        />
        <Fact
          label="Global concurrency"
          value={snapshot.concurrency === null ? 'Not configured' : String(snapshot.concurrency)}
        />
        <Fact label="Capacity" value={snapshot.maxed ? 'Maxed' : 'Available'} />
      </dl>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 border-l-2 border-line pl-3">
      <dt className="text-[11px] font-medium text-faint">{label}</dt>
      <dd className="mt-1 break-words font-mono text-sm text-fg">{value}</dd>
    </div>
  );
}
