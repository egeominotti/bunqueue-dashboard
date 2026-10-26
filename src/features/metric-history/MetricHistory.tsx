import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { LoadingState } from '@/components/ui/feedback';
import { Field, Input, SegmentedControl } from '@/components/ui/form';
import { PageHeader } from '@/components/ui/PageHeader';
import { queueHttpPathError } from '@/lib/upstreamPaths';
import {
  HISTORY_WINDOWS,
  type HistoryView,
  type HistoryWindow,
  METRIC_TYPES,
  type MetricCoverage,
  type MetricType,
} from './model';
import { useMetricHistory } from './useMetricHistory';

export function MetricHistory({ initialQueue = '' }: { initialQueue?: string }) {
  const [draft, setDraft] = useState(initialQueue);
  const [queue, setQueue] = useState(initialQueue);
  const [window, setWindow] = useState<HistoryWindow>('1h');
  const { view, error, loading, reload } = useMetricHistory(queue, window);
  const invalid = draft ? queueHttpPathError(draft.trim()) : null;
  return (
    <div className="space-y-4">
      <PageHeader
        title="Native metric history"
        description="Completed jobs and terminal failures in Bunqueue's retained one-minute buckets."
        actions={
          <Button disabled={!queue || loading} onClick={reload}>
            Refresh
          </Button>
        }
      />
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (draft.trim() && !invalid) setQueue(draft.trim());
        }}
      >
        <div className="min-w-48 flex-1">
          <Field label="Queue name">
            <Input
              name="metric-history-queue"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
          </Field>
        </div>
        <Button type="submit" disabled={!draft.trim() || Boolean(invalid)}>
          Load history
        </Button>
        <SegmentedControl
          options={HISTORY_WINDOWS}
          value={window}
          onChange={setWindow}
          label="History window"
        />
      </form>
      {invalid && (
        <p role="alert" className="text-sm text-danger">
          {invalid}
        </p>
      )}
      {!queue && <p className="text-sm text-muted">Choose a queue to read native history.</p>}
      {loading && <LoadingState label="Reading native metric history…" />}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {view && (
        <>
          <h2 className="text-lg font-semibold text-fg">
            {queue} · {window}
          </h2>
          <p className="text-xs text-muted">
            Window: {timestamp(view.start)} through {timestamp(view.end)} (UTC minute starts).
          </p>
          <div className="grid gap-4 md:grid-cols-2">
            {METRIC_TYPES.map((type) => (
              <Summary
                key={type}
                type={type}
                coverage={view.series[type]}
                minutes={view.cells.length}
              />
            ))}
          </div>
          <Timeline view={view} />
        </>
      )}
      <p className="text-xs leading-5 text-faint">
        Unknown time is left blank; observed totals cover returned buckets only. Idle queues keep
        old tails without new zero buckets. Retention belongs to Bunqueue (maxMetricDataPoints,
        default 20,160; zero disables retained buckets). History survives restarts only with broker
        persistence. These are live reads, captured separately for each metric.
      </p>
    </div>
  );
}

function Summary({
  type,
  coverage,
  minutes,
}: {
  type: MetricType;
  coverage: MetricCoverage;
  minutes: number;
}) {
  const status = {
    available: 'Retained buckets in this window',
    empty: 'No terminal events recorded',
    unretained: 'No retained buckets; retention may be disabled or history unavailable',
    'outside-window': 'Retained history is outside this window; the queue may be idle',
    unavailable: 'History unavailable; check the paired agent and server',
  }[coverage.status];
  return (
    <section
      data-summary={type}
      aria-label={`${type} history`}
      className="space-y-2 rounded-xl border border-line bg-surface p-4 text-sm text-muted"
    >
      <h3 className="font-semibold capitalize text-fg">
        {type === 'failed' ? 'Terminal failed' : 'Completed'}
      </h3>
      <p className="text-lg text-fg">Observed window total: {coverage.total ?? 'Unavailable'}</p>
      <p>{status}</p>
      {coverage.error && (
        <p role="alert" className="text-danger">
          {coverage.error}
        </p>
      )}
      <p>
        Known coverage: {coverage.knownMinutes} / {minutes} minutes
      </p>
      <p>
        Coverage range:{' '}
        {coverage.from === null
          ? 'None'
          : `${timestamp(coverage.from)} – ${timestamp(coverage.to)}`}
      </p>
      <p>Latest event: {timestamp(coverage.latestEvent)}</p>
      <p>
        {coverage.returnedBuckets} returned / {coverage.availableBuckets} available native buckets
      </p>
      <p>
        Lifetime terminal: {coverage.lifetimeTotal ?? 'Unavailable'} (separate from window total)
      </p>
    </section>
  );
}

function Timeline({ view }: { view: HistoryView }) {
  const maximum = Math.max(
    1,
    ...view.cells.flatMap((cell) => [cell.completed ?? 0, cell.failed ?? 0])
  );
  const path = (type: MetricType) =>
    view.cells
      .map((cell, index) => {
        const value = cell[type];
        if (value === null) return '';
        const x = (index / view.cells.length) * 1000;
        const y = 100 - (value / maximum) * 95;
        // Each segment occupies its actual minute; unknown minutes have no segment.
        return `M${x},${y}h${1000 / view.cells.length}`;
      })
      .filter(Boolean)
      .join(' ');
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="mb-3 flex gap-5 text-xs">
        <span className="text-accent">Completed</span>
        <span className="text-danger">Terminal failed</span>
      </div>
      <svg
        role="img"
        aria-label="Timestamp-aligned one-minute native buckets; blank time is unknown"
        viewBox="0 0 1000 110"
        className="h-48 w-full"
        preserveAspectRatio="none"
      >
        <title>Native metric counts, aligned by UTC minute</title>
        <path
          data-metric="completed"
          d={path('completed')}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="text-accent"
        />
        <path
          data-metric="failed"
          d={path('failed')}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="text-danger"
        />
      </svg>
      <div className="mt-2 flex justify-between gap-2 text-xs text-faint">
        <span>{timestamp(view.start)}</span>
        <span>{timestamp(view.end)}</span>
      </div>
    </div>
  );
}

function timestamp(value: number | null): string {
  if (value === null) return 'None';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unavailable timestamp' : date.toISOString();
}
