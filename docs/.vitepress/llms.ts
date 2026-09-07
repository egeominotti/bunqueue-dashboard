import llmstxt from 'vitepress-plugin-llms';

// Emits /llms.txt and /llms-full.txt with an accurate up-front project model.
export function createLlmsPlugin() {
  return llmstxt({
    title: 'bunqueue dashboard',
    description:
      'A web dashboard that fully drives a bunqueue server over its public HTTP API (:6790) plus a small local control agent that manages the server process. Built with React 19, React Router 7, Zustand 5, Vite and Bun.',
    details: [
      '## Mental model',
      '',
      "It **reads** Bunqueue 2.9.4 through HTTP polling and Server-Sent Events. HTTP commands include enqueue, pause/resume, eligible job promotion and scheduling, and queue policy changes. The dashboard deliberately disables DLQ retry, completed-job requeue, cancel, drain, clean and purge where Bunqueue lacks atomic generation/topology preconditions. Endpoint acceptance alone does not make a mutation safe. See `src/lib/jobActions.ts` and `src/lib/flowMutationSafety.ts`.",
      '',
      'The local **control agent** (`agent/`) manages start/stop/restart, read-only SQLite inspection, and the pinned public Bunqueue Queue/Flow/Workflow clients and backup CLI. Direct listeners bind to loopback. LAN or proxied access requires `AGENT_TOKEN` on every agent route, an explicit Host/Origin policy, and `BUNQUEUE_TOKEN` for the admin API proxy. Configure both tokens before exposing the dashboard; zero-configuration access applies only to genuinely local requests.',
      '',
      '## Two API clients, by design',
      '',
      '- `src/lib/api.ts`, the original client, used only by the first-generation **classic** pages (reachable at `*-classic` routes).',
      '- `src/lib/bq.ts`, the complete, shape-verified, strict-error-checked client behind every **Pro** control page (`src/pages/control/*`), which own the sidebar. New work uses `bq`. Its `call()` also throws on HTTP-200-with-`{ok:false}` (except `health()`).',
      '',
      '## Verified API-shape gotchas',
      '',
      '- `GET /webhooks`, `/workers`, `/storage`, `/ping` wrap the payload in `{ ok, data: {...} }`; `/queues/:q/dlq`, `/dlq/stats`, `/crons`, `/queues/:q/counts` are flat.',
      '- DLQ entries are nested `{ job, enteredAt, reason, error, attempts[] }`, with no top-level `id`/`name`.',
      '- Bunqueue 2.9.4 jobs expose first-class `name`, terminal `returnvalue`, and `failedReason`; they use `startedAt`/`completedAt` (not `processedOn`/`finishedOn`).',
      '',
      'For the full per-section walkthrough see the User guide pages; for endpoint shapes see API mapping; for honest current limits see Known issues.',
    ].join('\n'),
  });
}
