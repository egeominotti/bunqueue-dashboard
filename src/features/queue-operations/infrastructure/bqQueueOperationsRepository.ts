import { bq } from '@/lib/bq';
import type {
  QueueGroupSnapshot,
  QueueLimitSnapshot,
  QueueMetricsSnapshot,
  QueueOperationsRepository,
} from '../application/QueueOperationsRepository';

export const bqQueueOperationsRepository: QueueOperationsRepository = {
  limits: async (queue, maxJobs) => parseLimits(await bq.queueOperations.limits(queue, maxJobs)),
  group: async (queue, groupId, maxJobs, maxCount, start, end) =>
    parseGroup(await bq.queueOperations.group(queue, groupId, maxJobs, maxCount, start, end)),
  pauseGroup: async (queue, groupId) =>
    parseChanged(await bq.queueOperations.pauseGroup(queue, groupId)),
  resumeGroup: async (queue, groupId) =>
    parseChanged(await bq.queueOperations.resumeGroup(queue, groupId)),
  setGroupRateLimit: async (queue, groupId, max, duration) => {
    parseApplied(await bq.queueOperations.setGroupRateLimit(queue, groupId, max, duration));
  },
  removeGroupRateLimit: async (queue, groupId) =>
    parseRemoved(await bq.queueOperations.removeGroupRateLimit(queue, groupId)),
  setGroupConcurrency: async (queue, groupId, concurrency) => {
    parseApplied(await bq.queueOperations.setGroupConcurrency(queue, groupId, concurrency));
  },
  removeGroupConcurrency: async (queue, groupId) =>
    parseRemoved(await bq.queueOperations.removeGroupConcurrency(queue, groupId)),
  deduplicationJobId: async (queue, id) =>
    parseJobId(await bq.queueOperations.deduplicationJobId(queue, id)),
  removeDeduplicationKey: async (queue, id) =>
    parseRemoved(await bq.queueOperations.removeDeduplicationKey(queue, id)),
  metrics: async (queue, type, start, end) =>
    parseMetrics(await bq.queueOperations.metrics(queue, type, start, end)),
  trimEvents: async (queue, maxLength) =>
    parseRemoved(await bq.queueOperations.trimEvents(queue, maxLength)),
};

function parseGroup(value: unknown): QueueGroupSnapshot {
  const group = record(okRecord(value, 'Queue group').group, 'Queue group');
  const rate = group.rateLimit;
  const entries = group.entries;
  const priorityCounts = group.priorityCounts;
  if (
    !integerAtLeast(group.jobs, 0) ||
    !integerAtLeast(group.active, 0) ||
    !integerAtLeast(group.totalGrouped, 0) ||
    typeof group.paused !== 'boolean' ||
    !Array.isArray(entries) ||
    entries.length > 100 ||
    !entries.every(validGroupJob) ||
    !isRecord(priorityCounts) ||
    !Object.entries(priorityCounts).every(
      ([priority, count]) =>
        /^\d+$/.test(priority) && Number(priority) <= 2_097_151 && integerAtLeast(count, 0)
    ) ||
    (rate !== null &&
      (!isRecord(rate) || !positiveInteger(rate.max) || !positiveInteger(rate.duration))) ||
    !integerAtLeast(group.rateLimitTtl, -2) ||
    (group.concurrency !== null && !positiveInteger(group.concurrency))
  ) {
    throw malformed('Queue group');
  }
  return group as unknown as QueueGroupSnapshot;
}

function validGroupJob(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.name === 'string' &&
    value.name.length > 0 &&
    integerAtLeast(value.priority, 0) &&
    (value.priority as number) <= 2_097_151 &&
    integerAtLeast(value.delay, 0) &&
    integerAtLeast(value.timestamp, 0)
  );
}

function parseChanged(value: unknown): boolean {
  const changed = okRecord(value, 'Queue group mutation').changed;
  if (typeof changed !== 'boolean') throw malformed('Queue group mutation');
  return changed;
}

function parseApplied(value: unknown): void {
  if (okRecord(value, 'Queue mutation').applied !== true) throw malformed('Queue mutation');
}

function parseLimits(value: unknown): QueueLimitSnapshot {
  const root = okRecord(value, 'Queue limits');
  const limits = record(root.limits, 'Queue limits');
  const rate = limits.rateLimit;
  if (
    rate !== null &&
    (!isRecord(rate) || !positiveInteger(rate.max) || !positiveInteger(rate.duration))
  ) {
    throw malformed('Queue limits');
  }
  if (limits.concurrency !== null && !positiveInteger(limits.concurrency)) {
    throw malformed('Queue limits');
  }
  if (!integerAtLeast(limits.rateLimitTtl, -2) || typeof limits.maxed !== 'boolean') {
    throw malformed('Queue limits');
  }
  return {
    rateLimit: rate as QueueLimitSnapshot['rateLimit'],
    concurrency: limits.concurrency as number | null,
    rateLimitTtl: limits.rateLimitTtl as number,
    maxed: limits.maxed,
  };
}

function parseJobId(value: unknown): string | null {
  const id = okRecord(value, 'deduplication lookup').jobId;
  if (id !== null && (typeof id !== 'string' || !id)) throw malformed('deduplication lookup');
  return id as string | null;
}

function parseRemoved(value: unknown): number {
  const removed = okRecord(value, 'Queue mutation').removed;
  if (!integerAtLeast(removed, 0)) throw malformed('Queue mutation');
  return removed as number;
}

function parseMetrics(value: unknown): QueueMetricsSnapshot {
  const metrics = record(okRecord(value, 'Queue metrics').metrics, 'Queue metrics');
  const meta = record(metrics.meta, 'Queue metrics');
  if (
    !integerAtLeast(meta.count, 0) ||
    !integerAtLeast(meta.prevTS, 0) ||
    !integerAtLeast(meta.prevCount, 0) ||
    !integerAtLeast(metrics.count, 0) ||
    !Array.isArray(metrics.data) ||
    metrics.data.length > 10_001 ||
    !metrics.data.every((entry) => integerAtLeast(entry, 0))
  ) {
    throw malformed('Queue metrics');
  }
  return metrics as unknown as QueueMetricsSnapshot;
}

function okRecord(value: unknown, label: string): Record<string, unknown> {
  const result = record(value, label);
  if (result.ok !== true) throw malformed(label);
  return result;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw malformed(label);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const positiveInteger = (value: unknown) => integerAtLeast(value, 1);
const integerAtLeast = (value: unknown, minimum: number) =>
  Number.isSafeInteger(value) && (value as number) >= minimum;
const malformed = (label: string) => new Error(`Malformed ${label} response`);
