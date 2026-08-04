import { api } from '@/lib/api';
import type { Job, QueuesResponse } from '@/lib/types';

export const ALL_QUEUES = '__all__';
export const JOB_STATUS = ['all', 'waiting', 'active', 'completed', 'failed'] as const;
export type StatusFilter = (typeof JOB_STATUS)[number];
export const JOBS_PER_QUEUE = 40;
export const DISPLAY_LIMIT = 100;
export const MAX_ALL_QUEUE_JOB_FANOUT = 100;

const QUEUE_PAGE_SIZE = 500;
const MAX_QUEUE_PAGES = 20;
const MAX_DISCOVERED_QUEUES = QUEUE_PAGE_SIZE * MAX_QUEUE_PAGES;

export interface JobsLoad {
  scopeKey: string;
  jobs: Job[];
  failures: { queue: string; message: string }[];
  queueCount: number;
  blockedReason: string | null;
}

function validateQueuePage(
  page: QueuesResponse,
  requestedOffset: number,
  expectedTotal: number | null
): void {
  if (
    page == null ||
    typeof page !== 'object' ||
    page.ok !== true ||
    !Array.isArray(page.queues) ||
    !Number.isSafeInteger(page.total) ||
    page.total < 0 ||
    page.total > MAX_DISCOVERED_QUEUES ||
    (expectedTotal !== null && page.total !== expectedTotal) ||
    page.offset !== requestedOffset ||
    page.limit !== QUEUE_PAGE_SIZE ||
    page.queues.length !== Math.min(QUEUE_PAGE_SIZE, page.total - requestedOffset) ||
    page.queues.length > QUEUE_PAGE_SIZE ||
    page.queues.some(
      (row) =>
        row == null ||
        typeof row !== 'object' ||
        typeof row.name !== 'string' ||
        row.name.length === 0 ||
        row.name.length > 256 ||
        !/^[a-zA-Z0-9_\-.:]+$/.test(row.name)
    )
  ) {
    throw new Error('Queue discovery returned a malformed or unsafe page');
  }
}

export async function discoverAllQueues(): Promise<QueuesResponse> {
  const first = await api.queues(QUEUE_PAGE_SIZE, 0);
  validateQueuePage(first, 0, null);
  const queues = [...first.queues];
  const names = new Set<string>();
  for (const row of queues) {
    if (names.has(row.name))
      throw new Error(`Queue discovery returned duplicate queue ${row.name}`);
    names.add(row.name);
  }
  const total = first.total;
  let pageCount = 1;
  while (queues.length < total) {
    if (pageCount >= MAX_QUEUE_PAGES || queues.length >= MAX_DISCOVERED_QUEUES)
      throw new Error(`Queue discovery exceeds the safety limit of ${MAX_DISCOVERED_QUEUES}`);
    const offset = queues.length;
    const page = await api.queues(QUEUE_PAGE_SIZE, offset);
    validateQueuePage(page, offset, total);
    for (const row of page.queues) {
      if (names.has(row.name))
        throw new Error(`Queue discovery pages overlap at queue ${row.name}`);
      names.add(row.name);
      queues.push(row);
    }
    pageCount += 1;
  }
  return { ...first, queues, total, limit: queues.length, offset: 0 };
}

export function jobDataName(data: unknown): string | null {
  if (data == null || typeof data !== 'object' || Array.isArray(data)) return null;
  const name = (data as Record<string, unknown>).name;
  return typeof name === 'string' && name.length > 0 ? name : null;
}
