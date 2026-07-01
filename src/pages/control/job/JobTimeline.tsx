import { Card, CardHeader } from '@/components/ui/Card';
import { StatusBadge } from '@/components/ui/StatusBadge';
import type { JobFull } from '@/lib/bqTypes';
import { formatDateTime } from '@/lib/format';

/**
 * Attempt/state history: enqueued → started → finished (+ retries), each entry
 * from `job.timeline` (server-persisted, capped at MAX_TIMELINE_ENTRIES=20).
 */
export function JobTimeline({ timeline }: { timeline: JobFull['timeline'] }) {
  const entries = timeline ?? [];
  return (
    <Card>
      <CardHeader title="Timeline" />
      {entries.length === 0 ? (
        <p className="text-xs text-faint">No state transitions recorded yet.</p>
      ) : (
        <ol className="flex flex-col gap-0">
          {entries.map((e, i) => (
            <li
              // Timeline entries have no stable id; index is fine, order is append-only.
              // biome-ignore lint/suspicious/noArrayIndexKey: append-only server log, stable order
              key={i}
              className="border-b border-line/60 py-2 last:border-0"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <StatusBadge status={e.state} />
                  {e.attempt != null && (
                    <span className="font-mono text-[11px] text-faint">attempt {e.attempt}</span>
                  )}
                </div>
                <span className="font-mono text-xs text-muted">{formatDateTime(e.timestamp)}</span>
              </div>
              {(e.worker || e.error) && (
                <div className="mt-1 pl-0.5">
                  {e.worker && <div className="font-mono text-[11px] text-faint">{e.worker}</div>}
                  {e.error && <div className="mt-0.5 text-xs text-red-400/90">{e.error}</div>}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
