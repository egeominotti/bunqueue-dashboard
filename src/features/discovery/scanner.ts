import type { ConnectionProfileTarget } from '@/components/dashboard/stores/connectionStore';
import { createServerTargetClient } from '@/lib/bq/targetClient';
import { captureServerRequestTarget } from '@/lib/bq/transport';
import type { DlqEntryFull, JobFull } from '@/lib/bqTypes';
import { matchesJob } from './matching';
import type { DiscoveryQuery, DiscoveryRow, ScanLimits, ScanReport } from './model';

export const SCAN_LIMITS: Readonly<ScanLimits> = Object.freeze({
  queues: 100,
  jobs: 5000,
  requests: 100,
  milliseconds: 20000,
  results: 500,
});
class ScanStopped extends Error {}

export async function scanJobs(
  targets: readonly Readonly<ConnectionProfileTarget>[],
  query: DiscoveryQuery,
  signal: AbortSignal,
  requested: Partial<ScanLimits> = {}
): Promise<ScanReport> {
  const limits = { ...SCAN_LIMITS };
  for (const key of Object.keys(limits) as (keyof ScanLimits)[]) {
    const value = requested[key];
    if (value !== undefined && Number.isFinite(value))
      limits[key] = Math.max(1, Math.min(limits[key], Math.floor(value)));
  }
  const started = performance.now();
  const deadline = AbortSignal.timeout(limits.milliseconds);
  const lifecycle = AbortSignal.any([signal, deadline]);
  const selected = targets.filter(
    (target) => !query.profiles?.length || query.profiles.includes(target.id)
  );
  const report: ScanReport = {
    rows: [],
    coverage: selected.map((source) => ({
      profileId: source.id,
      profileName: source.name,
      status: 'skipped',
      queues: 0,
      inspectedJobs: 0,
      errors: [],
    })),
    inspectedJobs: 0,
    scannedQueues: 0,
    requests: 0,
    matches: 0,
    partial: false,
    cancelled: false,
    limitsHit: [],
    elapsedMs: 0,
  };
  for (const id of query.profiles ?? []) {
    if (!targets.some((target) => target.id === id))
      report.coverage.push({
        profileId: id,
        profileName: id,
        status: 'skipped',
        queues: 0,
        inspectedJobs: 0,
        errors: ['Profile is no longer configured.'],
      });
  }
  const hit = (key: keyof ScanLimits) => {
    if (!report.limitsHit.includes(key)) report.limitsHit.push(key);
  };
  const check = () => {
    if (signal.aborted) {
      report.cancelled = true;
      throw new ScanStopped();
    }
    if (deadline.aborted || performance.now() - started >= limits.milliseconds) {
      hit('milliseconds');
      throw new ScanStopped();
    }
  };
  const request = async <T>(operation: () => Promise<T>): Promise<T> => {
    check();
    if (report.requests >= limits.requests) {
      hit('requests');
      throw new ScanStopped();
    }
    report.requests++;
    const result = await operation();
    check();
    return result;
  };
  const seen = new Map<string, DiscoveryRow>();
  for (const [index, source] of selected.entries()) {
    const coverage = report.coverage[index];
    try {
      check();
      if (report.requests >= limits.requests) {
        hit('requests');
        break;
      }
      coverage.status = 'partial';
      const client = createServerTargetClient(captureServerRequestTarget(source), lifecycle);
      let queueOffset = 0;
      let total: number | undefined;
      const queueNames = new Set<string>();
      do {
        const page = await request(() => client.queuesPage(100, queueOffset));
        if (total !== undefined && total !== page.total)
          throw new Error('Queue total changed during pagination; coverage is partial.');
        total = page.total;
        coverage.discoveredQueues = total;
        for (const item of page.queues) {
          if (queueNames.has(item.name))
            throw new Error('Overlapping queue pages; coverage is partial.');
          queueNames.add(item.name);
          if (query.queue && item.name !== query.queue) continue;
          check();
          if (report.scannedQueues >= limits.queues) {
            hit('queues');
            throw new ScanStopped();
          }
          report.scannedQueues++;
          coverage.queues++;
          const add = (job: JobFull, dlq?: DlqEntryFull) => {
            check();
            if (report.inspectedJobs >= limits.jobs) {
              hit('jobs');
              throw new ScanStopped();
            }
            report.inspectedJobs++;
            coverage.inspectedJobs++;
            const key = JSON.stringify([source.id, item.name, job.id]);
            const prior = seen.get(key);
            if (prior) {
              if (dlq) prior.dlq = dlq;
              return;
            }
            const state = dlq ? 'dlq' : (job.state ?? 'unknown');
            const row = { source, queue: item.name, state, job, ...(dlq ? { dlq } : {}) };
            // Deduplicate all observed identities, including nonmatches.
            seen.set(key, row);
            const filter =
              dlq && query.includeDlq && query.state === 'failed'
                ? { ...query, state: undefined }
                : query;
            if (!matchesJob(job, item.name, filter, state)) return;
            report.matches++;
            if (report.rows.length < limits.results) report.rows.push(row);
            else hit('results');
          };
          if (query.state !== 'dlq') {
            let offset = 0;
            while (true) {
              const jobs = (
                await request(() =>
                  client.jobsList(item.name, query.state ? [query.state] : undefined, 100, offset)
                )
              ).jobs;
              if (jobs.length > 100) throw new Error('Oversized jobs page.');
              for (const job of jobs) add(job);
              if (jobs.length < 100) break;
              offset += 100;
            }
          }
          if (query.includeDlq || query.state === 'dlq') {
            let offset = 0;
            while (true) {
              const page = await request(() => client.dlq(item.name, 100, offset));
              if (page.entries.length > 100 || (page.entries.length === 0 && offset < page.total))
                throw new Error('Incomplete DLQ page.');
              for (const entry of page.entries) add(entry.job, entry);
              offset += page.entries.length;
              if (offset >= page.total) break;
            }
          }
        }
        queueOffset += page.queues.length;
      } while (queueOffset < total);
      coverage.status = 'complete';
    } catch (error) {
      if (signal.aborted) report.cancelled = true;
      if (deadline.aborted) hit('milliseconds');
      if (error instanceof ScanStopped || lifecycle.aborted) break;
      coverage.status = coverage.queues ? 'partial' : 'error';
      // Server response text can contain application secrets; retain only safe classification.
      coverage.errors.push(
        error instanceof Error && /queue|page|pagination/i.test(error.message)
          ? 'Invalid or changing paginated response.'
          : 'Source request failed. Check connection and authentication.'
      );
    }
  }
  report.partial =
    report.cancelled ||
    report.coverage.some((item) => item.status !== 'complete') ||
    report.limitsHit.some((key) => key !== 'results');
  report.elapsedMs = Math.round(performance.now() - started);
  return report;
}
