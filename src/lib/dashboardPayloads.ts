import type { QueueSummaryFull, WebhookFull, WorkerFull } from './bqTypes';

const MAX_COLLECTION_ROWS = 10_000;
const MAX_QUEUE_REFS = 1_000;
const MAX_DATE_MS = 8_640_000_000_000_000;
const WEBHOOK_EVENT_SET = new Set([
  'job.pushed',
  'job.started',
  'job.completed',
  'job.failed',
  'job.progress',
  // v2.9.3 keeps this legacy value readable in persisted registries even
  // though new registrations cannot request it and the server never emits it.
  'job.stalled',
]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, max: number, allowEmpty = false): value is string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && value.length === 0)) {
    return false;
  }
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function timestamp(value: unknown): value is number {
  return count(value) && value <= MAX_DATE_MS;
}

function optionalText(value: unknown, max: number): value is string | null {
  return value === null || text(value, max);
}

function stringList(value: unknown, maxItems: number, maxLength: number): value is string[] {
  if (!Array.isArray(value) || value.length > maxItems) return false;
  const unique = new Set<string>();
  for (const item of value) {
    if (!text(item, maxLength) || unique.has(item)) return false;
    unique.add(item);
  }
  return true;
}

function payloadData(value: unknown, label: string): Record<string, unknown> {
  const root = record(value);
  const data = root && record(root.data);
  if (root?.ok !== true || !data) throw new Error(`Malformed ${label} response.`);
  return data;
}

/** `/queues/summary` is a bare array in v2.9.3, so validate it explicitly. */
export function parseQueueSummaryPayload(value: unknown): QueueSummaryFull[] {
  // v2.9.3 returns every queue from this endpoint and defines no upper bound.
  // response.json() has already materialized the allocation here, so rejecting
  // a valid 10,001st row only makes the dashboard semantically incorrect.
  if (!Array.isArray(value)) {
    throw new Error('Malformed queue summary response.');
  }
  const names = new Set<string>();
  const summary: QueueSummaryFull[] = [];
  for (const candidate of value) {
    const queue = record(candidate);
    const counts = queue && record(queue.counts);
    if (
      !queue ||
      !text(queue.name, 256) ||
      names.has(queue.name) ||
      typeof queue.paused !== 'boolean' ||
      !counts ||
      !count(counts.waiting) ||
      !count(counts.prioritized) ||
      !count(counts.active) ||
      !count(counts.completed) ||
      !count(counts.failed) ||
      !count(counts.delayed)
    ) {
      throw new Error('Malformed queue summary response.');
    }
    names.add(queue.name);
    summary.push(candidate as QueueSummaryFull);
  }
  return summary;
}

export interface WorkersPayload {
  ok: true;
  data: { workers: WorkerFull[]; quarantinedWorkers: WorkerPayloadIssue[]; stats?: unknown };
}

export interface WorkerPayloadIssue {
  index: number;
  id: string | null;
  reason: string;
}

/** Validate every render-relevant worker field before the table consumes it. */
export function parseWorkersPayload(value: unknown): WorkersPayload {
  const data = payloadData(value, 'workers');
  if (!Array.isArray(data.workers) || data.workers.length > MAX_COLLECTION_ROWS) {
    throw new Error('Malformed workers response.');
  }
  const ids = new Set<string>();
  const workers: WorkerFull[] = [];
  const quarantinedWorkers: WorkerPayloadIssue[] = [];
  for (let index = 0; index < data.workers.length; index++) {
    const candidate = data.workers[index];
    const worker = record(candidate);
    const id = worker && typeof worker.id === 'string' ? worker.id : null;
    const issues: string[] = [];
    if (!worker) issues.push('entry is not an object');
    else {
      if (!text(worker.id, 1_024)) issues.push('id');
      else if (ids.has(worker.id)) issues.push('duplicate id');
      if (!text(worker.name, 512, true)) issues.push('name');
      if (!stringList(worker.queues, MAX_QUEUE_REFS, 256)) issues.push('queues');
      if (!count(worker.concurrency) || worker.concurrency < 1) issues.push('concurrency');
      if (!text(worker.hostname, 512, true)) issues.push('hostname');
      if (!count(worker.pid)) issues.push('pid');
      if (worker.status !== 'active' && worker.status !== 'stale') issues.push('status');
      if (!timestamp(worker.registeredAt)) issues.push('registeredAt');
      if (!timestamp(worker.lastSeen)) issues.push('lastSeen');
      if (!count(worker.activeJobs)) issues.push('activeJobs');
      if (!count(worker.processedJobs)) issues.push('processedJobs');
      if (!count(worker.failedJobs)) issues.push('failedJobs');
      if (!optionalText(worker.currentJob, 1_024)) issues.push('currentJob');
      // registeredAt is supplied by the worker clock, while uptime is derived
      // by the server clock. A valid v2.9.3 worker can therefore be negative.
      if (!finiteNumber(worker.uptime)) issues.push('uptime');
    }
    if (id) ids.add(id);
    if (issues.length > 0) {
      quarantinedWorkers.push({ index, id, reason: issues.join(', ') });
      continue;
    }
    workers.push(candidate as WorkerFull);
  }
  return {
    ok: true,
    data: {
      workers,
      quarantinedWorkers,
      ...(Object.hasOwn(data, 'stats') ? { stats: data.stats } : {}),
    },
  };
}

export interface WebhooksPayload {
  ok: true;
  data: { webhooks: WebhookFull[]; stats?: unknown };
}

function upstreamWebhookUrl(value: unknown): value is string {
  if (!text(value, 2_048)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Reject hostile 2xx webhook registries instead of crashing or lying in UI. */
export function parseWebhooksPayload(value: unknown): WebhooksPayload {
  const data = payloadData(value, 'webhooks');
  if (!Array.isArray(data.webhooks) || data.webhooks.length > MAX_COLLECTION_ROWS) {
    throw new Error('Malformed webhooks response.');
  }
  const ids = new Set<string>();
  const webhooks: WebhookFull[] = [];
  for (const candidate of data.webhooks) {
    const webhook = record(candidate);
    if (
      !webhook ||
      !text(webhook.id, 1_024) ||
      ids.has(webhook.id) ||
      !upstreamWebhookUrl(webhook.url) ||
      !Array.isArray(webhook.events) ||
      !webhook.events.every((event) => WEBHOOK_EVENT_SET.has(event)) ||
      !(webhook.queue === null || typeof webhook.queue === 'string') ||
      !timestamp(webhook.createdAt) ||
      !(webhook.lastTriggered === null || timestamp(webhook.lastTriggered)) ||
      !count(webhook.successCount) ||
      !count(webhook.failureCount) ||
      typeof webhook.enabled !== 'boolean'
    ) {
      throw new Error('Malformed webhooks response.');
    }
    ids.add(webhook.id);
    webhooks.push(candidate as WebhookFull);
  }
  return {
    ok: true,
    data: { webhooks, ...(Object.hasOwn(data, 'stats') ? { stats: data.stats } : {}) },
  };
}
