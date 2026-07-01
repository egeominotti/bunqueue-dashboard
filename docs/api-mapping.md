# API mapping & shape gotchas

`bq` (`src/lib/bq.ts`) targets bunqueue's HTTP API. Shapes below were **verified
against a running server** — several differ from what the route/command source
suggests, so trust this table over guessing from the server source alone.

## Response-shape gotchas (important)

| Endpoint | Envelope | Notes |
| --- | --- | --- |
| `GET /storage` | `{ ok, data: { diskFull, error, since } }` | **wrapped in `data`**; no `path` field |
| `GET /webhooks` | `{ ok, data: { webhooks[], stats } }` | **wrapped in `data`** |
| `GET /workers` | `{ ok, data: { workers[], stats } }` | **wrapped in `data`** |
| `GET /ping` | `{ ok, data: { pong, time } }` | **wrapped in `data`** |
| `GET /health` | `{ ok, status, version, uptime, queues, connections, memory }` | flat; `ok` is a **health flag** (disk-full → `false` with HTTP 200), not a request-success flag — see "Strict mode" below |
| `GET /queues/:q/dlq` | `{ ok, entries[], total }` | flat (no `data`) |
| `GET /queues/:q/dlq/stats` | `{ ok, stats }` | flat |
| `GET /crons` | `{ ok, crons[] }` | flat |
| `GET /queues/:q/counts` | `{ ok, counts }` | flat |
| `GET /queues/summary` | `[{ name, paused, counts:{waiting,active,completed,failed,delayed} }]` | **bare array**, no `{ ok }` envelope at all; one round-trip for every queue's full counts (see [pages.md](pages.md) / A5 in the project changelog) |

- **DLQ entry** = `{ job, enteredAt, reason, error, attempts[] }`. The job is
  **nested**; there is no top-level `id`/`name`. Use `entry.job.id`. (The
  classic `lib/types.ts` `DlqEntry` gets this wrong — see
  [known-issues.md](known-issues.md).)
- **Jobs** have **no `name`** field, and expose **`startedAt` / `completedAt`**
  (not `processedOn` / `finishedOn`). Duration = `completedAt − startedAt`.
  A job's *result* is **not** embedded on the job object — it's only
  available via `GET /jobs/:id/result`, even for a `completed` job. `bq.job()`
  and `bq.jobResult()` must both be called if you need both.
- **Job `timeline`** (`Array<{state,timestamp,worker?,error?,attempt?}>`) is
  pushed on every state transition (enqueue, start, complete/fail, requeue)
  and — despite an in-source comment suggesting otherwise — **is persisted**
  to SQLite as a packed blob and restored on read, capped at 20 entries
  (`MAX_TIMELINE_ENTRIES`). It's present for completed and DLQ'd jobs too, not
  just in-memory ones.
- **`backoffConfig`** is `{ type: 'fixed'|'exponential', delay, maxDelay? } |
  null`. `null` doesn't mean "no backoff" — it means the job used the plain
  numeric `backoff` field with the server's default strategy (exponential,
  `job.backoff * 2^attemptsMade`, ±50% jitter, capped at 1h). The
  `Queue.add()` client SDK only accepts a numeric `backoff` at the top level
  today (no object form), so in practice `backoffConfig` is null for almost
  every job pushed through the standard SDK path.
- Job `delay` is **milliseconds, relative**; timestamps are ms.

## Strict mode: `{ ok: false }` on HTTP 200

Several mutating endpoints return **HTTP 200 even on logical failure**, with
`{ ok: false, error }` in the body — cancelling a job that's already
finished, purging an empty DLQ, rate-limiting an unknown queue, etc. `bq.ts`'s
`call()` parses every response and throws a `BqError` when it sees
`ok === false`, so these now surface as errors at the call site instead of
silently resolving as success. **One deliberate exception:** `bq.health()`
passes `strict:false`, because `/health`'s `ok` field means "is the server
healthy" (legitimately `false` while still a fully successful, informative
response) — treating that as a thrown error would break any page rendering a
"degraded" state. If you add a new endpoint whose `ok` means something other
than request-success, follow that pattern (`srv(path, init, false)`) rather
than special-casing it in a page.

`lib/api.ts` (the classic client) does **not** implement this check — it only
throws on non-2xx HTTP status. Classic pages that call an always-200 mutating
endpoint (e.g. `Jobs.tsx`'s per-row Cancel via `api.cancelJob`) can still show
a false "success" for a logically-failed action. Not retrofitted, per the
additive rule — new pages use `bq`.

## Job action gating

Which job actions the server will actually accept depends on the job's
**current state** (really: its internal *location* — queue vs. processing vs.
storage). `lib/jobActions.ts::actionGates(state)` is the single client-side
model of this, used by both `JobInspector` and `JobsPro` so they can't drift:

| Action | Endpoint | Valid states | Why |
| --- | --- | --- | --- |
| Cancel | `DELETE /jobs/:id` | `waiting`, `delayed`, `prioritized`, `waiting-children` | `cancelJob` only handles the `queue`-location branch server-side; active/completed/DLQ'd jobs return `false` (→ now throws, see Strict mode above) |
| Discard (→ DLQ) | `POST /jobs/:id/discard` | the above **+** `active` | `discardJob` also handles the `processing`-location branch |
| Set priority | `PUT /jobs/:id/priority` | `waiting`, `delayed`, `prioritized`, `waiting-children` | `changeJobPriority` is queue-location only |
| Set/move delay | `PUT /jobs/:id/delay`, `POST /jobs/:id/move-to-delayed` | queue states **+** `active` | `changeDelay` routes to `changeWaitingDelay` (queue) or `moveJobToDelayed` (processing) |
| Promote (run now) | `POST /jobs/:id/promote` | `delayed` only | `promoteJob` requires `location.type==='queue'` **and** `runAt > now` |
| Retry (move to waiting) | `POST /jobs/:id/move-to-wait` | `active` only | `moveActiveToWait` is specifically Active → Waiting |
| Retry from DLQ | `POST /queues/:q/dlq/retry { jobId }` | `failed` only | the only retry path for a job that's actually in the DLQ table |
| Requeue | `POST /queues/:q/retry-completed { id }` | `completed` only | `retryCompletedJobs(queue, ctx, jobId)` resets `attempts`/`startedAt`/`completedAt`/`runAt` and re-inserts into the waiting queue — this **is** the "requeue a completed job" action; it verifies `job.queue === queue` first |

A state not listed for a given action means the server-side handler returns
`false` for that location — pre-my-fix that resolved as a silent no-op
Promise; post-fix it throws. The dashboard avoids ever offering the button in
the first place by computing `actionGates` from the job's live `state`.

## Request bodies

| Action | Method · Path | Body |
| --- | --- | --- |
| Add job | `POST /queues/:q/jobs` | `{ data, priority?, delay?, maxAttempts?, backoff?, timeout?, jobId?, removeOnComplete?, removeOnFail?, durable?, ttl?, uniqueKey?, lifo? }` → `{ ok, id }` |
| Add bulk | `POST /queues/:q/jobs/bulk` | `{ jobs: [...] }` → `{ ok, ids }` — **a shared `jobId` across elements dedupes to one job server-side**, but `ids` still has one entry per element (see known-issues.md) |
| Update data | `PUT /jobs/:id/data` | `{ data }` |
| Change priority | `PUT /jobs/:id/priority` | `{ priority }` |
| Change/move delay | `PUT /jobs/:id/delay` · `POST /jobs/:id/move-to-delayed` | `{ delay }` (ms) |
| Fail | `POST /jobs/:id/fail` | `{ error? }` |
| Clean | `POST /queues/:q/clean` | `{ grace?, state?, limit? }` → `{ ok, count }` |
| Promote delayed | `POST /queues/:q/promote-jobs` | `{ count? }` → `{ ok, count }` |
| Retry completed | `POST /queues/:q/retry-completed` | `{ id? }` → `{ ok, count }` — omit `id` to requeue every completed job in the queue; **requeue** semantics (see Job action gating above), not a re-run-in-place |
| Rate limit | `PUT /queues/:q/rate-limit` | `{ limit }` |
| Concurrency | `PUT /queues/:q/concurrency` | `{ concurrency }` (or `{ limit }`) |
| Stall config | `PUT /queues/:q/stall-config` | `{ config: { enabled, stallInterval, maxStalls, gracePeriod } }` |
| DLQ policy | `PUT /queues/:q/dlq-config` | `{ config: { autoRetry, autoRetryInterval, maxAutoRetries, maxAge, maxEntries } }` |
| Retry DLQ | `POST /queues/:q/dlq/retry` | `{ jobId? }` → `{ ok, count }` — omit `jobId` to retry every entry |
| Create cron | `POST /crons` | `{ name, queue, data?, schedule? \| repeatEvery?, priority?, timezone?, … }` |
| Add webhook | `POST /webhooks` | `{ url, events[], queue?, secret? }` (events ∈ `job.pushed/started/completed/failed/progress`) |

## Live stream

`GET /events` (or `/events/queues/:q`) — SSE. The **first frame is a
handshake** — `retry: 3000` followed by `data: {"connected":true,"clientId":…}`
with **no `event:` line**, so it parses with the SSE-spec default event name
`"message"`, not a literal `"connected"` event (see
[known-issues.md](known-issues.md) for the dashboard-side consequence). After
that: `job:pushed`, `job:active`, `job:completed`, `job:failed`,
`job:progress`, … plus `queue:counts` and periodic `stats:snapshot` /
`health:status` system frames. Job-event payloads carry `queue`/`jobId`/
`timestamp` plus optional `error`/`progress`/`prev`/`delay` — **never a job
name** (jobs don't have one server-side). `useActivityStream` maps event
suffix → status and keeps a bounded buffer + counters + rolling throughput.

## Auth

If the server sets `AUTH_TOKENS`, provide a token (Settings or
`VITE_BUNQUEUE_TOKEN`); `bq`/`api` send `Authorization: Bearer <token>`, and the
SSE reader (fetch-based, not `EventSource`) sends it too — `EventSource` can't
carry custom headers, which is exactly why `lib/sse.ts` exists instead of the
native API.
