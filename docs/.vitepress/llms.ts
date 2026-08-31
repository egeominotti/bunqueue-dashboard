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
      "It **reads** from a bunqueue server by polling the HTTP API (`usePolledData`, interval from the connection store) and subscribing to a Server-Sent-Events stream (`useActivityStream`) for live job activity. It **writes** through the same API (pause, add job, retry, rate-limit, and so on), with every job action gated by the job's real current state via `src/lib/jobActions.ts::actionGates` so the UI never offers an action the server would reject.",
      '',
      'The one thing HTTP cannot do, manage the server **process**, is delegated to a small local **control agent** (`agent/`): loopback-bound (127.0.0.1), CORS-locked to an allowlist, with an optional `AGENT_TOKEN` bearer gate, exposing `/control/*` to start, stop and restart bunqueue, plus a read-only SQLite inspector over `/db/*`.',
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
      '- Bunqueue 2.9.0 jobs expose first-class `name`, terminal `returnvalue`, and `failedReason`; they use `startedAt`/`completedAt` (not `processedOn`/`finishedOn`).',
      '',
      'For the full per-section walkthrough see the User guide pages; for endpoint shapes see API mapping; for honest current limits see Known issues.',
    ].join('\n'),
  });
}
