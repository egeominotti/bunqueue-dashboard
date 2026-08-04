export interface QueueLimitSnapshot {
  rateLimit: { max: number; duration: number } | null;
  concurrency: number | null;
  rateLimitTtl: number;
  maxed: boolean;
}

export interface QueueMetricsSnapshot {
  meta: { count: number; prevTS: number; prevCount: number };
  data: number[];
  count: number;
}

export interface QueueOperationsRepository {
  limits(queue: string, maxJobs?: number): Promise<QueueLimitSnapshot>;
  deduplicationJobId(queue: string, deduplicationId: string): Promise<string | null>;
  removeDeduplicationKey(queue: string, deduplicationId: string): Promise<number>;
  metrics(
    queue: string,
    type: 'completed' | 'failed',
    start: number,
    end: number
  ): Promise<QueueMetricsSnapshot>;
  trimEvents(queue: string, maxLength: number): Promise<number>;
}
