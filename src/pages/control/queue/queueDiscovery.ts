import { bq } from '@/lib/bq';
import type { QueuesResponse } from '@/lib/types';
import { isDlqConfig, isStallConfig } from './configModel';

export const COUNT_KEYS = [
  'waiting',
  'prioritized',
  'active',
  'completed',
  'failed',
  'delayed',
  'waiting-children',
  'paused',
] as const;
const QUEUE_PAGE_SIZE = 500;
const MAX_QUEUE_PAGES = 200;
const MAX_DISCOVERED_QUEUES = QUEUE_PAGE_SIZE * MAX_QUEUE_PAGES;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function hasRenderedCounts(value: unknown): value is Record<(typeof COUNT_KEYS)[number], number> {
  return isRecord(value) && COUNT_KEYS.every((key) => isCount(value[key]));
}

function assertQueuePage(value: unknown, expectedOffset: number): asserts value is QueuesResponse {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    !Array.isArray(value.queues) ||
    !isCount(value.total) ||
    !isCount(value.limit) ||
    value.limit < 1 ||
    !isCount(value.offset) ||
    value.offset !== expectedOffset ||
    typeof value.timestamp !== 'number' ||
    !Number.isFinite(value.timestamp) ||
    !value.queues.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.name === 'string' &&
        entry.name.length > 0 &&
        isCount(entry.waiting) &&
        isCount(entry.delayed) &&
        isCount(entry.active) &&
        isCount(entry.dlq) &&
        typeof entry.paused === 'boolean'
    )
  ) {
    throw new Error('Malformed /dashboard/queues response.');
  }
}

export async function loadAllQueuePages(): Promise<QueuesResponse> {
  const first = await bq.queues(QUEUE_PAGE_SIZE, 0);
  assertQueuePage(first, 0);
  const snapshotTotal = first.total;
  if (snapshotTotal > MAX_DISCOVERED_QUEUES) {
    throw new Error(
      `Queue discovery reported ${snapshotTotal} queues, above the safe dashboard limit of ${MAX_DISCOVERED_QUEUES}.`
    );
  }
  if (first.queues.length !== Math.min(QUEUE_PAGE_SIZE, snapshotTotal)) {
    throw new Error(
      `Incomplete /dashboard/queues page at offset 0: expected ${Math.min(QUEUE_PAGE_SIZE, snapshotTotal)} queues, received ${first.queues.length}.`
    );
  }
  const byName = new Map<string, QueuesResponse['queues'][number]>();
  const addPage = (page: QueuesResponse) => {
    for (const entry of page.queues) {
      if (byName.has(entry.name))
        throw new Error(
          `Overlapping /dashboard/queues pages: queue "${entry.name}" appeared more than once.`
        );
      byName.set(entry.name, entry);
    }
  };
  addPage(first);
  let offset = first.queues.length;
  let pageCount = 1;
  while (offset < snapshotTotal) {
    if (pageCount >= MAX_QUEUE_PAGES)
      throw new Error(`Queue discovery exceeded the safe limit of ${MAX_QUEUE_PAGES} pages.`);
    const page = await bq.queues(QUEUE_PAGE_SIZE, offset);
    assertQueuePage(page, offset);
    if (page.total !== snapshotTotal)
      throw new Error(
        `Queue discovery changed during pagination: total moved from ${snapshotTotal} to ${page.total}. Retry the snapshot.`
      );
    const expectedLength = Math.min(QUEUE_PAGE_SIZE, snapshotTotal - offset);
    if (page.queues.length !== expectedLength)
      throw new Error(
        `Incomplete /dashboard/queues page at offset ${offset}: expected ${expectedLength} queues, received ${page.queues.length}.`
      );
    addPage(page);
    offset += page.queues.length;
    pageCount += 1;
  }
  if (byName.size !== snapshotTotal)
    throw new Error(
      `Incomplete /dashboard/queues snapshot: expected ${snapshotTotal} unique queues, received ${byName.size}.`
    );
  return {
    ...first,
    queues: [...byName.values()],
    total: snapshotTotal,
    limit: QUEUE_PAGE_SIZE,
    offset: 0,
  };
}

export function assertQueueDetail(value: unknown, expectedQueue: string): void {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    value.name !== expectedQueue ||
    typeof value.paused !== 'boolean' ||
    !hasRenderedCounts(value.counts)
  ) {
    throw new Error(`Malformed queue detail response for "${expectedQueue}".`);
  }
}

export function readStallConfig(value: unknown) {
  if (!isRecord(value) || value.ok !== true || !isStallConfig(value.config))
    throw new Error('Malformed /stall-config response.');
  return value.config;
}

export function readDlqConfig(value: unknown) {
  if (!isRecord(value) || value.ok !== true || !isDlqConfig(value.config))
    throw new Error('Malformed /dlq-config response.');
  return value.config;
}

export function actionResultCount(value: unknown): number | undefined {
  if (!isRecord(value) || value.ok !== true)
    throw new Error('Malformed queue action response: expected { ok: true }.');
  if (value.count === undefined) return undefined;
  if (!isCount(value.count))
    throw new Error('Malformed queue action response: count must be a non-negative integer.');
  return value.count;
}

export function resolveQueueSelection(
  selected: string,
  queues: ReadonlyArray<{ name: string }>
): string {
  return queues.some((entry) => entry.name === selected) ? selected : (queues[0]?.name ?? '');
}
