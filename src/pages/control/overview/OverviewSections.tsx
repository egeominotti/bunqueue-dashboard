import { Link } from 'react-router-dom';
import { Card } from '@/components/ui/Card';
import { IconArrowRight } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { formatNumber, formatRelativeTime } from '@/lib/format';
import { useActivityStream } from '@/lib/useActivityStream';

export function RecentActivity() {
  const { events, connected, error } = useActivityStream();
  return (
    <div className="mt-8">
      <SectionHeading title="Recent Activity" to="/logs" />
      <Card padded={false}>
        {error && events.length > 0 && (
          <p className="border-b border-line px-5 py-2 text-xs text-warning">
            Event stream unavailable — {error.message}. Reconnecting…
          </p>
        )}
        {events.length === 0 ? (
          <p
            role={error ? 'alert' : undefined}
            className={cn('py-8 text-center text-sm', error ? 'text-warning' : 'text-faint')}
          >
            {error
              ? `Event stream unavailable — ${error.message}. Reconnecting…`
              : connected
                ? 'Waiting for live activity…'
                : 'Connecting to the event stream…'}
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {events.slice(0, 8).map((event) => (
              <li key={event.seq} className="flex items-center justify-between px-5 py-3">
                <div className="flex items-center gap-3">
                  <span className={cn('size-2 rounded-full', activityDot(event.status))} />
                  <div className="text-sm">
                    <span className="font-mono font-medium text-fg">{event.queue || '—'}</span>
                    <span className="text-faint"> · </span>
                    <span className="font-mono text-xs text-faint">
                      {event.jobId ? event.jobId.slice(0, 8) : '—'}
                    </span>
                    <span className="text-faint"> · </span>
                    <span className="capitalize text-muted">{event.status}</span>
                  </div>
                </div>
                <span className="text-xs text-faint">{formatRelativeTime(event.timestamp)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

export function SectionHeading({ title, to }: { title: string; to: string }) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <h2 className="text-lg font-semibold text-fg">{title}</h2>
      <Link to={to} className="flex items-center gap-1 text-sm text-muted hover:text-fg">
        View All <IconArrowRight className="size-3.5" />
      </Link>
    </div>
  );
}

export function QueueMetric({
  label,
  value,
  tone,
}: {
  label: string;
  value?: number;
  tone: string;
}) {
  return (
    <span>
      {label}{' '}
      <span className={cn('tnum font-semibold', tone)}>
        {value == null ? '—' : formatNumber(value)}
      </span>
    </span>
  );
}

function activityDot(status: string): string {
  if (status === 'completed') return 'bg-emerald-400';
  if (status === 'failed') return 'bg-red-400';
  if (status === 'active') return 'bg-blue-400';
  if (status === 'waiting') return 'bg-amber-400';
  return 'bg-accent';
}
