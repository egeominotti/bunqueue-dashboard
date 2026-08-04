import type { AlertRule, Operator } from '@/components/dashboard/stores/alertsStore';
import type {
  AlertOverview,
  AlertQueueClient,
  AlertQueueRow,
  AlertSummaryRow,
} from './alertEngineTransport';
import { bq } from './bq';

export interface Breach {
  ruleId: string;
  ruleName: string;
  metricLabel: string;
  operator: Operator;
  threshold: number;
  value: number;
  queue: string;
  at: number;
}

export interface AlertMetricContext {
  summary: AlertSummaryRow[] | null;
  queues: AlertQueueRow[] | null;
  overview: AlertOverview | null;
}

const MAX_ALERT_QUEUES = 10_500;
const QUEUE_PAGE_SIZE = 500;
const MAX_QUEUE_PAGES = 21;
const alertCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function compareAlertMetric(value: number, op: Operator, threshold: number): boolean {
  if (op === '>=') return value >= threshold;
  if (op === '>') return value > threshold;
  if (op === '<=') return value <= threshold;
  if (op === '<') return value < threshold;
  return false;
}

export function parseAlertQueueSummary(value: unknown): AlertSummaryRow[] | null {
  if (!Array.isArray(value) || value.length > MAX_ALERT_QUEUES) return null;
  const names = new Set<string>();
  const rows: AlertSummaryRow[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
    const row = candidate as Record<string, unknown>;
    const counts = row.counts;
    if (
      typeof row.name !== 'string' ||
      !row.name ||
      row.name.length > 256 ||
      !/^[a-zA-Z0-9_\-.:]+$/.test(row.name) ||
      names.has(row.name) ||
      typeof row.paused !== 'boolean' ||
      !counts ||
      typeof counts !== 'object' ||
      Array.isArray(counts)
    )
      return null;
    const values = counts as Record<string, unknown>;
    if (
      !['waiting', 'active', 'completed', 'failed', 'delayed'].every((key) =>
        alertCount(values[key])
      )
    ) {
      return null;
    }
    names.add(row.name);
    rows.push(candidate as AlertSummaryRow);
  }
  return rows;
}

export function parseAlertOverview(value: unknown): AlertOverview | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const root = value as Record<string, unknown>;
  if (
    root.ok !== true ||
    !root.latency ||
    typeof root.latency !== 'object' ||
    Array.isArray(root.latency)
  ) {
    return null;
  }
  const percentiles = (root.latency as Record<string, unknown>).percentiles;
  if (!percentiles || typeof percentiles !== 'object' || Array.isArray(percentiles)) return null;
  for (const operation of Object.values(percentiles)) {
    const p99 = (operation as { p99?: unknown } | null)?.p99;
    if (
      !operation ||
      typeof operation !== 'object' ||
      Array.isArray(operation) ||
      typeof p99 !== 'number' ||
      !Number.isFinite(p99) ||
      p99 < 0
    ) {
      return null;
    }
  }
  return value as AlertOverview;
}

const pct = (completed: number, failed: number): number | null => {
  const total = completed + failed;
  return total > 0 ? (failed / total) * 100 : null;
};

export function alertMetricValue(rule: AlertRule, ctx: AlertMetricContext): number | null {
  const queue = rule.queue.trim();
  if (rule.metric === 'waiting' || rule.metric === 'failed') {
    if (!ctx.summary) return null;
    const key = rule.metric;
    if (queue) return ctx.summary.find((row) => row.name === queue)?.counts[key] ?? null;
    return ctx.summary.reduce((sum, row) => sum + row.counts[key], 0);
  }
  if (rule.metric === 'dlq') {
    if (!ctx.queues) return null;
    if (queue) return ctx.queues.find((row) => row.name === queue)?.dlq ?? null;
    return ctx.queues.reduce((sum, row) => sum + (row.dlq ?? 0), 0);
  }
  if (rule.metric === 'error_rate') {
    if (!ctx.summary) return null;
    if (queue) {
      const row = ctx.summary.find((item) => item.name === queue);
      return row ? pct(row.counts.completed, row.counts.failed) : null;
    }
    return pct(
      ctx.summary.reduce((sum, row) => sum + row.counts.completed, 0),
      ctx.summary.reduce((sum, row) => sum + row.counts.failed, 0)
    );
  }
  const percentiles = ctx.overview?.latency?.percentiles;
  if (!percentiles) return null;
  const values = Object.values(percentiles)
    .map((item) => item.p99)
    .filter(Number.isFinite);
  return values.length ? Math.max(...values) : null;
}

function parseQueuePage(value: unknown, offset: number, expectedTotal: number | null) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const page = value as Record<string, unknown>;
  if (
    page.ok !== true ||
    !Array.isArray(page.queues) ||
    !Number.isSafeInteger(page.total) ||
    (page.total as number) < 0 ||
    (page.total as number) > MAX_ALERT_QUEUES ||
    (expectedTotal !== null && page.total !== expectedTotal)
  )
    return null;
  if (page.offset !== offset || page.limit !== QUEUE_PAGE_SIZE) return null;
  const total = page.total as number;
  if (page.queues.length !== Math.min(QUEUE_PAGE_SIZE, total - offset)) return null;
  const queues: AlertQueueRow[] = [];
  for (const candidate of page.queues) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
    const row = candidate as Record<string, unknown>;
    if (
      typeof row.name !== 'string' ||
      !row.name ||
      row.name.length > 256 ||
      !/^[a-zA-Z0-9_\-.:]+$/.test(row.name) ||
      !alertCount(row.dlq)
    )
      return null;
    queues.push(candidate as AlertQueueRow);
  }
  return { queues, total };
}

export async function allQueues(client: AlertQueueClient = bq): Promise<AlertQueueRow[] | null> {
  try {
    const rows: AlertQueueRow[] = [];
    const names = new Set<string>();
    let total: number | null = null;
    for (let page = 0; page < MAX_QUEUE_PAGES; page++) {
      const parsed = parseQueuePage(
        await client.queues(QUEUE_PAGE_SIZE, rows.length),
        rows.length,
        total
      );
      if (!parsed) return null;
      total ??= parsed.total;
      for (const row of parsed.queues) {
        if (names.has(row.name)) return null;
        names.add(row.name);
        rows.push(row);
      }
      if (rows.length === total) return rows;
    }
    return null;
  } catch {
    return null;
  }
}
