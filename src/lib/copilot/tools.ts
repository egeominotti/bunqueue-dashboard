import { tool } from 'ai';
import { z } from 'zod';
import { useCopilotStore } from '@/components/dashboard/stores/copilotStore';
import {
  assertCurrentServerRequestTarget,
  captureServerRequestTarget,
  createServerTargetClient,
  type ServerRequestTarget,
} from '@/lib/bq';

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
  globalThis.crypto?.randomUUID?.() ??
  `${Date.now()}-${(uidSeq++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

interface ToolMeta {
  name: string;
  label: string;
  mutates: boolean;
}

/** Wrap a bq action with ToolEvent bookkeeping + (for mutations) a confirm gate. */
async function run<T>(
  msgId: string,
  target: ServerRequestTarget,
  meta: ToolMeta,
  args: unknown,
  action: () => Promise<T>,
  turnSignal?: AbortSignal
) {
  const stopped = () => ({ ok: false, aborted: true, message: 'The Copilot turn was stopped.' });
  if (turnSignal?.aborted) return stopped();

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
    if (turnSignal?.aborted) {
      s.updateTool(msgId, evId, { status: 'declined' });
      return stopped();
    }
    s.updateTool(msgId, evId, { status: 'running' });
  }

  try {
    if (turnSignal?.aborted) {
      s.updateTool(msgId, evId, {
        status: meta.mutates ? 'declined' : 'error',
        error: 'The Copilot turn was stopped.',
      });
      return stopped();
    }
    // The confirmation was rendered for this exact target. A Settings change
    // while the card was pending invalidates it; never redirect an approved
    // action to the new live store, nor silently execute it on the old server.
    if (meta.mutates) assertCurrentServerRequestTarget(target);
    const result = await action();
    if (turnSignal?.aborted) {
      s.updateTool(msgId, evId, {
        status: meta.mutates ? 'declined' : 'error',
        error: 'The Copilot turn was stopped.',
      });
      return stopped();
    }
    s.updateTool(msgId, evId, { status: 'done', result });
    return result;
  } catch (e) {
    if (turnSignal?.aborted) {
      s.updateTool(msgId, evId, {
        status: meta.mutates ? 'declined' : 'error',
        error: 'The Copilot turn was stopped.',
      });
      return stopped();
    }
    const error = (e as Error).message || 'request failed';
    s.updateTool(msgId, evId, { status: 'error', error });
    return { ok: false, error };
  }
}

/**
 * Build one assistant turn's tools around a single immutable URL + bearer
 * snapshot. Direct callers may omit the target; it is still captured exactly
 * once here, before any tool closure exists.
 */
export function buildTools(
  msgId: string,
  target: ServerRequestTarget = captureServerRequestTarget(),
  turnSignal?: AbortSignal
) {
  const client = createServerTargetClient(target, turnSignal);
  const mutationLabel = (label: string) => `${label} on server ${target.baseUrl}`;
  const executeTool = <T>(meta: ToolMeta, args: unknown, action: () => Promise<T>) =>
    run(msgId, target, meta, args, action, turnSignal);

  return {
    list_queues: tool({
      description:
        'List all queues with their job counts (waiting, active, completed, failed, delayed, dlq).',
      inputSchema: z.object({}),
      execute: () =>
        executeTool({ name: 'list_queues', label: 'List queues', mutates: false }, {}, () =>
          client.queuesSummary()
        ),
    }),
    queue_counts: tool({
      description: 'Get the exact job counts for one queue by state.',
      inputSchema: z.object({ queue: z.string().describe('Queue name') }),
      execute: ({ queue }) =>
        executeTool(
          { name: 'queue_counts', label: `Counts: ${queue}`, mutates: false },
          { queue },
          () => client.counts(queue)
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
        executeTool(
          { name: 'list_jobs', label: `Jobs: ${queue}`, mutates: false },
          { queue, states, limit },
          () => client.jobsList(queue, states, limit ?? 20)
        ),
    }),
    get_job: tool({
      description:
        'Fetch one job by id, including its state, data, attempts, timeline, parent/children.',
      inputSchema: z.object({ id: z.string() }),
      execute: ({ id }) =>
        executeTool(
          { name: 'get_job', label: `Job ${id.slice(0, 8)}`, mutates: false },
          { id },
          () => client.job(id)
        ),
    }),
    dlq_stats: tool({
      description: 'Get dead-letter-queue statistics for a queue (count, reasons).',
      inputSchema: z.object({ queue: z.string() }),
      execute: ({ queue }) =>
        executeTool(
          { name: 'dlq_stats', label: `DLQ stats: ${queue}`, mutates: false },
          { queue },
          () => client.dlqStats(queue)
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
        executeTool(
          { name: 'list_dlq', label: `DLQ: ${queue}`, mutates: false },
          { queue, limit },
          () => client.dlq(queue, limit ?? 25)
        ),
    }),
    server_health: tool({
      description: 'Get overall server health and status.',
      inputSchema: z.object({}),
      execute: () =>
        executeTool({ name: 'server_health', label: 'Health', mutates: false }, {}, () =>
          client.health()
        ),
    }),
    server_stats: tool({
      description: 'Get aggregate server stats (totals across queues, throughput).',
      inputSchema: z.object({}),
      execute: () =>
        executeTool({ name: 'server_stats', label: 'Stats', mutates: false }, {}, () =>
          client.stats()
        ),
    }),
    list_workers: tool({
      description: 'List connected workers and their status.',
      inputSchema: z.object({}),
      execute: () =>
        executeTool({ name: 'list_workers', label: 'Workers', mutates: false }, {}, () =>
          client.workers()
        ),
    }),
    list_crons: tool({
      description: 'List scheduled cron jobs.',
      inputSchema: z.object({}),
      execute: () =>
        executeTool({ name: 'list_crons', label: 'Crons', mutates: false }, {}, () =>
          client.crons()
        ),
    }),

    // --- Mutating tools (confirmation-gated) ---
    promote_job: tool({
      description: 'Promote a delayed job so it runs now. Mutating: needs user confirmation.',
      inputSchema: z.object({ id: z.string() }),
      execute: ({ id }) =>
        executeTool(
          {
            name: 'promote_job',
            label: mutationLabel(`Promote job ${id.slice(0, 8)}`),
            mutates: true,
          },
          { id },
          () => client.promoteJob(id)
        ),
    }),
    pause_queue: tool({
      description: 'Pause a queue (stops processing new jobs). Mutating: needs user confirmation.',
      inputSchema: z.object({ queue: z.string() }),
      execute: ({ queue }) =>
        executeTool(
          {
            name: 'pause_queue',
            label: mutationLabel(`Pause ${queue}`),
            mutates: true,
          },
          { queue },
          () => client.pause(queue)
        ),
    }),
    resume_queue: tool({
      description: 'Resume a paused queue. Mutating: needs user confirmation.',
      inputSchema: z.object({ queue: z.string() }),
      execute: ({ queue }) =>
        executeTool(
          {
            name: 'resume_queue',
            label: mutationLabel(`Resume ${queue}`),
            mutates: true,
          },
          { queue },
          () => client.resume(queue)
        ),
    }),
  };
}
