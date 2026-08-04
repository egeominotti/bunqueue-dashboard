import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select } from '@/components/ui/form';
import type {
  QueueMetricsSnapshot,
  QueueOperationsRepository,
} from '../application/QueueOperationsRepository';
import type { QueueOperationRunner } from './QueueOperationsPanel';

export function QueueTelemetryConsole({
  queue,
  repository,
  busy,
  run,
}: {
  queue: string;
  repository: QueueOperationsRepository;
  busy: string;
  run: QueueOperationRunner;
}) {
  const [type, setType] = useState<'completed' | 'failed'>('completed');
  const [start, setStart] = useState('0');
  const [end, setEnd] = useState('29');
  const [retention, setRetention] = useState('1000');
  const [metrics, setMetrics] = useState<QueueMetricsSnapshot | null>(null);
  const [trimReceipt, setTrimReceipt] = useState('');
  const range = metricRange(start, end);
  const maxLength = boundedWhole(retention, 0, 1_000_000);
  const load = () => {
    if (!range) return;
    run(
      `Reading ${type} metrics`,
      () => repository.metrics(queue, type, range.start, range.end),
      setMetrics
    );
  };
  const trim = () => {
    if (maxLength === null) return;
    if (
      !window.confirm(
        `Retain at most ${maxLength} lifecycle events for queue "${queue}"? Older journal events are permanently removed; metric buckets are unchanged.`
      )
    )
      return;
    run(
      'Trimming lifecycle journal',
      () => repository.trimEvents(queue, maxLength),
      (removed) => setTrimReceipt(`${removed} lifecycle events removed.`),
      true
    );
  };
  return (
    <section
      aria-labelledby="queue-telemetry-title"
      className="border-t border-line pt-4 xl:border-t-0"
    >
      <h3 id="queue-telemetry-title" className="text-sm font-semibold text-fg">
        Durable queue telemetry
      </h3>
      <p className="mt-1 mb-4 text-xs leading-5 text-faint">
        Read paged one-minute completion or failure buckets, and bound the lifecycle-event journal.
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Metric">
          <Select
            name="queue-sdk-metric-type"
            value={type}
            onChange={(event) => setType(event.target.value as 'completed' | 'failed')}
          >
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
          </Select>
        </Field>
        <Field label="Start bucket">
          <Input
            name="queue-sdk-metric-start"
            type="number"
            min={0}
            max={10_000}
            value={start}
            onChange={(event) => setStart(event.target.value)}
          />
        </Field>
        <Field label="End bucket" hint="Use -1 for all remaining buckets">
          <Input
            name="queue-sdk-metric-end"
            type="number"
            min={-1}
            max={10_000}
            value={end}
            onChange={(event) => setEnd(event.target.value)}
          />
        </Field>
      </div>
      <Button className="mt-3" size="sm" disabled={!range || Boolean(busy)} onClick={load}>
        Read metrics
      </Button>
      {!range && (
        <p role="alert" className="mt-2 text-xs text-danger">
          Use integer buckets from 0 to 10000; end must be -1 or at least start.
        </p>
      )}
      {metrics && <MetricSummary metrics={metrics} />}
      <div className="mt-5 flex flex-wrap items-end gap-3 border-t border-line pt-4">
        <div className="min-w-48 flex-1">
          <Field label="Retain lifecycle events" hint="0 clears the queue journal">
            <Input
              name="queue-sdk-event-retention"
              type="number"
              min={0}
              max={1_000_000}
              value={retention}
              onChange={(event) => setRetention(event.target.value)}
            />
          </Field>
        </div>
        <Button
          variant="warning"
          size="sm"
          disabled={maxLength === null || Boolean(busy)}
          onClick={trim}
        >
          Trim journal
        </Button>
      </div>
      {trimReceipt && (
        <p role="status" className="mt-3 text-xs text-success">
          {trimReceipt}
        </p>
      )}
    </section>
  );
}

function MetricSummary({ metrics }: { metrics: QueueMetricsSnapshot }) {
  const buckets = metrics.data.slice(0, 120).map((value, offset) => ({
    timestamp: metrics.meta.prevTS - offset * 60_000,
    value,
    offset,
  }));
  const maximum = Math.max(1, ...buckets.map((bucket) => bucket.value));
  return (
    <div className="mt-4 rounded-lg bg-surface-2 p-3">
      <div className="flex flex-wrap gap-x-5 gap-y-1 font-mono text-xs text-muted">
        <span>Total terminal: {metrics.meta.count}</span>
        <span>Available buckets: {metrics.count}</span>
        <span>Latest bucket: {metrics.meta.prevCount}</span>
      </div>
      {buckets.length ? (
        <div
          className="mt-3 flex h-16 items-end gap-px overflow-hidden"
          role="img"
          aria-label={`${buckets.length} one-minute metric buckets, newest first`}
        >
          {buckets.map((bucket) => (
            <span
              key={bucket.timestamp}
              title={`Bucket ${bucket.offset}: ${bucket.value}`}
              className="min-w-px flex-1 bg-accent/70"
              style={{ height: `${Math.max(2, (bucket.value / maximum) * 100)}%` }}
            />
          ))}
        </div>
      ) : (
        <p className="mt-3 text-xs text-faint">No buckets in this range.</p>
      )}
      {metrics.data.length > buckets.length && (
        <p className="mt-2 text-[11px] text-faint">Showing the first 120 returned buckets.</p>
      )}
    </div>
  );
}

function metricRange(start: string, end: string): { start: number; end: number } | null {
  const first = boundedWhole(start, 0, 10_000);
  const last = boundedWhole(end, -1, 10_000);
  if (first === null || last === null || (last !== -1 && last < first)) return null;
  return { start: first, end: last };
}

function boundedWhole(value: string, minimum: number, maximum: number): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}
