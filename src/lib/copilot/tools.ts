import { tool } from 'ai';
import { z } from 'zod';
import { useCopilotStore } from '@/components/dashboard/stores/copilotStore';
import { bq } from '@/lib/bq';

/**
 * Copilot tools. READ tools run immediately; MUTATING tools pause on the
 * confirmation gate (store.requestConfirm) and only touch the server after the
 * user clicks Confirm in the chat. Every tool reports its lifecycle as a
 * ToolEvent on the in-progress assistant message so the UI can show what the
 * model is doing. Failures are returned to the model (not thrown) so it can
 * recover instead of the whole turn aborting.
 */

// See copilotStore's uid(): crypto.randomUUID is secure-context-only, so on a
// plain-http origin the fallback runs and a bare `${Date.now()}` would give two
// tools started in the same millisecond the same ToolEvent id (updateTool would
// then patch both chips). Counter + random suffix keeps them distinct.
let uidSeq = 0;
const uid = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${(uidSeq++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

interface ToolMeta {
  name: string;
  label: string;
  mutates: boolean;
}

/** Wrap a bq action with ToolEvent bookkeeping + (for mutations) a confirm gate. */
async function run<T>(msgId: string, meta: ToolMeta, args: unknown, action: () => Promise<T>) {
  const s = useCopilotStore.getState();
  const evId = uid();
  s.addTool(msgId, {
    id: evId,
    name: meta.name,
    label: meta.label,
    mutates: meta.mutates,
    status: meta.mutates ? 'awaiting' : 'running',
    args,
  });

  if (meta.mutates) {
    const approved = await s.requestConfirm({ name: meta.name, label: meta.label, args });
    if (!approved) {
      s.updateTool(msgId, evId, { status: 'declined' });
      return { ok: false, declined: true, message: 'The user declined this action.' };
    }
    s.updateTool(msgId, evId, { status: 'running' });
  }

  try {
    const result = await action();
    s.updateTool(msgId, evId, { status: 'done', result });
    return result;
  } catch (e) {
    const error = (e as Error).message || 'request failed';
    s.updateTool(msgId, evId, { status: 'error', error });
    return { ok: false, error };
  }
}

/** Build the tool set for one assistant turn, bound to its message id. */
export function buildTools(msgId: string) {
  return {
    list_queues: tool({
      description:
        'List all queues with their job counts (waiting, active, completed, failed, delayed, dlq).',
      inputSchema: z.object({}),
      execute: () =>
        run(msgId, { name: 'list_queues', label: 'List queues', mutates: false }, {}, () =>
          bq.queuesSummary()
        ),
    }),
    queue_counts: tool({
      description: 'Get the exact job counts for one queue by state.',
      inputSchema: z.object({ queue: z.string().describe('Queue name') }),
      execute: ({ queue }) =>
        run(
          msgId,
          { name: 'queue_counts', label: `Counts: ${queue}`, mutates: false },
          { queue },
          () => bq.counts(queue)
        ),
    }),
    list_jobs: tool({
      description:
        'List jobs in a queue, optionally filtered by state (waiting, active, completed, failed, delayed).',
      inputSchema: z.object({
        queue: z.string(),
        states: z.array(z.string()).optional().describe('Job states to include'),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      execute: ({ queue, states, limit }) =>
        run(
          msgId,
          { name: 'list_jobs', label: `Jobs: ${queue}`, mutates: false },
          { queue, states, limit },
          () => bq.jobsList(queue, states, limit ?? 20)
        ),
    }),
    get_job: tool({
      description:
        'Fetch one job by id, including its state, data, attempts, timeline, parent/children.',
      inputSchema: z.object({ id: z.string() }),
      execute: ({ id }) =>
        run(
          msgId,
          { name: 'get_job', label: `Job ${id.slice(0, 8)}`, mutates: false },
          { id },
          () => bq.job(id)
        ),
    }),
    dlq_stats: tool({
      description: 'Get dead-letter-queue statistics for a queue (count, reasons).',
      inputSchema: z.object({ queue: z.string() }),
      execute: ({ queue }) =>
        run(
          msgId,
          { name: 'dlq_stats', label: `DLQ stats: ${queue}`, mutates: false },
          { queue },
          () => bq.dlqStats(queue)
        ),
    }),
    list_dlq: tool({
      description:
        'List dead-letter-queue entries for a queue (failed jobs that exhausted retries).',
      inputSchema: z.object({
        queue: z.string(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      execute: ({ queue, limit }) =>
        run(
          msgId,
          { name: 'list_dlq', label: `DLQ: ${queue}`, mutates: false },
          { queue, limit },
          () => bq.dlq(queue, limit ?? 25)
        ),
    }),
    server_health: tool({
      description: 'Get overall server health and status.',
      inputSchema: z.object({}),
      execute: () =>
        run(msgId, { name: 'server_health', label: 'Health', mutates: false }, {}, () =>
          bq.health()
        ),
    }),
    server_stats: tool({
      description: 'Get aggregate server stats (totals across queues, throughput).',
      inputSchema: z.object({}),
      execute: () =>
        run(msgId, { name: 'server_stats', label: 'Stats', mutates: false }, {}, () => bq.stats()),
    }),
    list_workers: tool({
      description: 'List connected workers and their status.',
      inputSchema: z.object({}),
      execute: () =>
        run(msgId, { name: 'list_workers', label: 'Workers', mutates: false }, {}, () =>
          bq.workers()
        ),
    }),
    list_crons: tool({
      description: 'List scheduled cron jobs.',
      inputSchema: z.object({}),
      execute: () =>
        run(msgId, { name: 'list_crons', label: 'Crons', mutates: false }, {}, () => bq.crons()),
    }),

    // --- Mutating tools (confirmation-gated) ---
    retry_job: tool({
      description:
        'Move a failed/completed job back to waiting so it runs again. Mutating: needs user confirmation.',
      inputSchema: z.object({ id: z.string() }),
      execute: ({ id }) =>
        run(
          msgId,
          { name: 'retry_job', label: `Retry job ${id.slice(0, 8)}`, mutates: true },
          { id },
          () => bq.retryJob(id)
        ),
    }),
    remove_job: tool({
      description: 'Permanently remove a job by id. Mutating: needs user confirmation.',
      inputSchema: z.object({ id: z.string() }),
      execute: ({ id }) =>
        run(
          msgId,
          { name: 'remove_job', label: `Remove job ${id.slice(0, 8)}`, mutates: true },
          { id },
          () => bq.cancelJob(id)
        ),
    }),
    promote_job: tool({
      description: 'Promote a delayed job so it runs now. Mutating: needs user confirmation.',
      inputSchema: z.object({ id: z.string() }),
      execute: ({ id }) =>
        run(
          msgId,
          { name: 'promote_job', label: `Promote job ${id.slice(0, 8)}`, mutates: true },
          { id },
          () => bq.promoteJob(id)
        ),
    }),
    pause_queue: tool({
      description: 'Pause a queue (stops processing new jobs). Mutating: needs user confirmation.',
      inputSchema: z.object({ queue: z.string() }),
      execute: ({ queue }) =>
        run(msgId, { name: 'pause_queue', label: `Pause ${queue}`, mutates: true }, { queue }, () =>
          bq.pause(queue)
        ),
    }),
    resume_queue: tool({
      description: 'Resume a paused queue. Mutating: needs user confirmation.',
      inputSchema: z.object({ queue: z.string() }),
      execute: ({ queue }) =>
        run(
          msgId,
          { name: 'resume_queue', label: `Resume ${queue}`, mutates: true },
          { queue },
          () => bq.resume(queue)
        ),
    }),
    retry_dlq: tool({
      description:
        'Retry dead-letter-queue jobs for a queue: one by jobId, or all if jobId is omitted. Mutating: needs user confirmation.',
      inputSchema: z.object({ queue: z.string(), jobId: z.string().optional() }),
      execute: ({ queue, jobId }) =>
        run(
          msgId,
          {
            name: 'retry_dlq',
            label: jobId ? `Retry DLQ job in ${queue}` : `Retry ALL DLQ in ${queue}`,
            mutates: true,
          },
          { queue, jobId },
          () => bq.retryDlq(queue, jobId)
        ),
    }),
    purge_dlq: tool({
      description:
        'Permanently delete all dead-letter-queue entries for a queue. Mutating: needs user confirmation.',
      inputSchema: z.object({ queue: z.string() }),
      execute: ({ queue }) =>
        run(
          msgId,
          { name: 'purge_dlq', label: `Purge DLQ: ${queue}`, mutates: true },
          { queue },
          () => bq.purgeDlq(queue)
        ),
    }),
  };
}
