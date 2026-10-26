import type { DiscoveryRow } from './model';

export interface FailureGroup {
  signature: string;
  message: string;
  firstStackLine: string;
  count: number;
  exampleIds: string[];
  queues: string[];
  profiles: string[];
  lastObservedAt?: number;
  examples: DiscoveryRow[];
}
export function normalizeFailure(text: string): string {
  return text
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu, '<uuid>')
    .replace(/\s+/gu, ' ')
    .trim();
}
export function groupFailures(rows: readonly DiscoveryRow[]): FailureGroup[] {
  const groups = new Map<string, FailureGroup>();
  for (const row of rows) {
    const message = normalizeFailure(
      row.dlq?.error || row.job.failedReason || row.dlq?.reason || 'Failure text unavailable'
    );
    const firstStackLine = normalizeFailure(row.job.stacktrace?.[0]?.split(/\r?\n/u)[0] ?? '');
    const signature = JSON.stringify([message, firstStackLine]);
    const group = groups.get(signature) ?? {
      signature,
      message,
      firstStackLine,
      count: 0,
      exampleIds: [],
      queues: [],
      profiles: [],
      examples: [],
    };
    group.count++;
    if (!group.queues.includes(row.queue)) group.queues.push(row.queue);
    if (!group.profiles.includes(row.source.name)) group.profiles.push(row.source.name);
    if (group.examples.length < 5) {
      group.examples.push(row);
      group.exampleIds.push(row.job.id);
    }
    const time =
      row.dlq?.attempts?.at(-1)?.failedAt ??
      row.dlq?.enteredAt ??
      row.job.completedAt ??
      row.job.timeline?.filter((entry) => entry.state === 'failed').at(-1)?.timestamp;
    if (typeof time === 'number' && Number.isFinite(time))
      group.lastObservedAt = Math.max(group.lastObservedAt ?? time, time);
    groups.set(signature, group);
  }
  return [...groups.values()].sort(
    (a, b) => b.count - a.count || a.signature.localeCompare(b.signature)
  );
}
