---
title: API mapping
description: "Every bunqueue HTTP endpoint the dashboard drives, with verified request and response shapes and the job-action state table."
---

# API mapping & shape gotchas

`bq` (`src/lib/bq.ts`) targets bunqueue's HTTP API. Shapes below were verified
against the exact [bunqueue v2.8.57 release](https://github.com/egeominotti/bunqueue/releases/tag/v2.8.57)
(`7b6da8c`); several differ from older dashboard assumptions.

## Workflow Engine

Workflow Engine is a Bunqueue client-library API, not part of the Bunqueue HTTP
server surface. The local control agent exposes a read-only observability
adapter over the official SQLite store:

| Agent endpoint | Contract |
| --- | --- |
| `GET /workflows/stats` | Active/archive totals, active state counts, and workflow names |
| `GET /workflows?kind=&workflowName=&state=&limit=&offset=` | Deterministic execution summaries, capped at 100 rows |
| `GET /workflows/:id?kind=active\|archive` | Decoded input, step records, resolved paths, signals, decisions, definition/rollback metadata |

The adapter uses the same structured-clone MessagePack codec as Bunqueue
2.8.57 and opens the configured `dataPath` read-only. It never implements
`Engine.start`, `signal`, `recover`, `resumeCompensation`, or
`abandonCompensation`: those operations require the live Engine instance and
its registered handlers, and Bunqueue exposes no equivalent HTTP control plane.

## Response-shape gotchas (important)

| Endpoint | Envelope | Notes |
| --- | --- | --- |
| `GET /storage` | `{ ok, data: { diskFull, error, since } }` | **wrapped in `data`**; no `path` field |
| `GET /webhooks` | `{ ok, data: { webhooks[], stats } }` | **wrapped in `data`** |
| `GET /workers` | `{ ok, data: { workers[], stats } }` | **wrapped in `data`** |
| `GET /ping` | `{ ok, data: { pong, time } }` | **wrapped in `data`** |
| `GET /health` | `{ ok, status, version, uptime, queues, connections, memory, storage? }` | flat; `ok` is a **health flag**. Disk-full returns the structured degraded body with **HTTP 503**, which both clients deliberately accept as diagnostic data |
| `GET /queues/:q/dlq` | `{ ok, entries[], total }` | flat (no `data`) |
| `GET /queues/:q/dlq/stats` | `{ ok, stats }` | flat |
| `GET /crons` | `{ ok, crons[] }` | flat |
| `GET /queues/:q/counts` | `{ ok, counts }` | flat |
| `GET /queues/summary` | `[{ name, paused, counts:{waiting,active,completed,failed,delayed} }]` | **bare array**, no `{ ok }` envelope at all; one round-trip for every queue's full counts (see [pages.md](pages.md) / A5 in the project changelog) |

- **DLQ entry** = `{ job, enteredAt, reason, error, attempts[] }`. The job is
  **nested**; there is no top-level `id`/`name`. Both clients use
  `entry.job.id` and model the attempt history as an array.
- **Jobs have a first-class `name`**, separate from arbitrary user `data`, and
  expose **`startedAt` / `completedAt`** (not `processedOn` / `finishedOn`).
  Duration = `completedAt − startedAt`. Direct and list reads embed terminal
  `returnvalue` and `failedReason`; the dedicated `GET /jobs/:id/result` route
  remains available for older compatible servers.
- **Job `timeline`** (`Array<{state,timestamp,worker?,error?,attempt?}>`) is
  pushed on every state transition (enqueue, start, complete/fail, requeue)
  and, despite an in-source comment suggesting otherwise, **is persisted**
  to SQLite as a packed blob and restored on read, capped at 20 entries
  (`MAX_TIMELINE_ENTRIES`). It's present for completed and DLQ'd jobs too, not
  just in-memory ones.
- **`backoffConfig`** is `{ type: 'fixed'|'exponential', delay, maxDelay? } |
  null`. `null` doesn't mean "no backoff", it means the job used the plain
  numeric `backoff` field with the server's default strategy (exponential,
  `job.backoff * 2^attemptsMade`, ±50% jitter, capped at 1h). v2.8.57 accepts
  both numeric and structured backoff inputs. One upstream readback caveat:
  SQLite's list-row serializer currently restores `backoffConfig` and the
  deduplication detail fields as defaults, so `/jobs/list` can omit those
  details even though `GET /jobs/:id` still reports the live job accurately.
- Job `delay` is **milliseconds, relative**; timestamps are ms.

## Strict mode: `{ ok: false }` on HTTP 200

Several mutating endpoints return **HTTP 200 even on logical failure**, with
`{ ok: false, error }` in the body, cancelling a job that's already
finished, purging an empty DLQ, rate-limiting an unknown queue, etc. `bq.ts`'s
`call()` parses every response and throws a `BqError` when it sees
`ok === false`, so these now surface as errors at the call site instead of
silently resolving as success. **One deliberate exception:** `bq.health()`
passes `strict:false`, because `/health`'s `ok` field means "is the server
healthy" (legitimately `false` in the informative HTTP 503 disk-full response),
treating that as a thrown error would break any page rendering a
"degraded" state. If you add a new endpoint whose `ok` means something other
than request-success, follow that pattern (`srv(path, init, false)`) rather
than special-casing it in a page.

`lib/api.ts` (the classic client) implements the same logical-failure check,
with `strict:false` for health/storage responses whose `ok` field represents
health rather than request success.

## Job action gating

The upstream endpoints below still exist, but endpoint availability is not the
same as dashboard authorization. `lib/jobActions.ts::actionGates(state)` is the
single client-side model used by `JobInspector` and `JobsPro`; it additionally
fails closed where v2.8.57 cannot prove worker or reverse-flow safety:

| Action | Endpoint | Upstream scope | Dashboard exposure |
| --- | --- | --- | --- |
| Cancel | `DELETE /jobs/:id` | Queue-resident jobs | **Never.** Hidden reverse dependencies can be stranded. |
| Discard (→ DLQ) | `POST /jobs/:id/discard` | Queue or processing location, without an expected-state precondition or terminal flow-failure resolution | **Never.** A stale runnable snapshot can become active, and a flow child can strand its parent. |
| Edit data | `PUT /jobs/:id/data` | Replaces the complete payload | Waiting/delayed/prioritized non-Flow jobs only. Flow jobs are read-only because replacement would erase reserved parent/children metadata. |
| Set priority / delay | `PUT /jobs/:id/priority` · `PUT /jobs/:id/delay` | Queue location (and active for some delay paths) | Waiting/delayed/prioritized only. |
| Promote | `POST /jobs/:id/promote` | Delayed only | Delayed only. |
| Retry active | `POST /jobs/:id/move-to-wait` | Active only | **Never.** It can duplicate side effects from the still-running worker. |
| Retry from DLQ | `POST /queues/:q/dlq/retry { jobId }` | Failed/DLQ | **Never.** The separate GET + POST has no atomic job-generation, state or topology precondition; the POST can hit a different job recreated under the same ID. |
| Requeue | `POST /queues/:q/retry-completed { id }` | Completed only | **Never.** Upstream `retryCompleted` does not reconstruct dependency registration or original flow order. |

A logical `{ok:false}` always throws. The dashboard also refuses unsafe actions
before transport, even where the upstream handler would accept them. A pinned
target, exact ID and fresh empty-topology snapshot cannot authorize DLQ retry:
none of those observations is an atomic condition on the later POST.

The dashboard Copilot uses the same fail-closed policy. Its only mutating tools
are Promote, Pause and Resume; DLQ retry and completed-job requeue are absent.

## Request bodies

| Action | Method · Path | Body |
| --- | --- | --- |
| Add job | `POST /queues/:q/jobs` | `{ name?, data, priority?, delay?, maxAttempts?, backoff?, timeout?, jobId?, removeOnComplete?, removeOnFail?, durable?, ttl?, uniqueKey?, lifo?, tags?, groupId?, dependsOn?, repeat? }` → `{ ok, id }`. `name` defaults to `default` and is separate from user `data`. The dashboard accepts only interval repeat `{ every, limit? }`: v2.8.57's continuation path treats `pattern` as `every ?? 0`, so cron expressions must use `/crons`. The client validates and sends one captured JSON representation, preventing mutable getters or root `toJSON()` from changing repeat, IDs, dependencies or topology after preflight |
| Add bulk | `POST /queues/:q/jobs/bulk` | `{ jobs: JobInput[] }` → `{ ok, ids }`; the domain shape calls a custom id `customId`, so the client translates dashboard `jobId` before sending. Bulk spec mode preserves tags/groups/dependencies, structured backoff, repeat/dedup, and the remaining v2.8.57 JobInput controls. The dashboard incrementally serializes at most 10,000 jobs, caps the exact translated JSON envelope at 64 MiB, validates repeat/ID/dependency/topology safety from those captured fragments, and sends the same string so getters or `toJSON()` cannot create a second-pass bypass |
| Update data | `PUT /jobs/:id/data` | `{ data }` |
| Change priority | `PUT /jobs/:id/priority` | `{ priority, lifo? }` |
| Change/move delay | `PUT /jobs/:id/delay` · `POST /jobs/:id/move-to-delayed` | `{ delay }` (ms) |
| Fail | `POST /jobs/:id/fail` | `{ error?, unrecoverable?, stack? }` |
| Clean | `POST /queues/:q/clean` | `{ grace?, state?, limit? }` → `{ ok, count }`; upstream route documented, intentionally not exposed outside session-owned Benchmark cleanup |
| Promote delayed | `POST /queues/:q/promote-jobs` | `{ count? }` → `{ ok, count }` |
| Retry completed | `POST /queues/:q/retry-completed` | Upstream accepts `{ id? }` → `{ ok, count }` (omitting `id` targets every completed job), but the dashboard never calls it because `retryCompleted` does not rebuild dependency registration/flow order |
| Rate limit | `PUT /queues/:q/rate-limit` | `{ limit, duration?, ttl? }` |
| Concurrency | `PUT /queues/:q/concurrency` | `{ concurrency }` (or `{ limit }`) |
| Stall config | `PUT /queues/:q/stall-config` | `{ config: { enabled, stallInterval, maxStalls, gracePeriod } }` |
| DLQ policy | `PUT /queues/:q/dlq-config` | Upstream accepts `{ config: { autoRetry, autoRetryInterval, maxAutoRetries, maxAge, maxEntries } }`. Dashboard saves omit `maxAge` and `maxEntries` because they drive destructive expiry/evacuation without an atomic target check; those fields are read-only. It may send `autoRetry:false` but rejects enabling it. |
| Retry DLQ | `POST /queues/:q/dlq/retry` | Upstream accepts `{ jobId? }`; the dashboard never calls either the exact-ID or retry-all form because the mutation has no atomic generation/state/topology precondition |
| Create/upsert cron | `POST /crons` | Last-writer-wins upsert `{ name, jobName?, queue, data?, schedule? \| repeatEvery?, priority?, timezone?, dedup?, jobOptions? }`; `jobName` is assigned to every spawned job and defaults to `default`; there is no atomic create-only precondition |
| Add webhook | `POST /webhooks` | `{ url, events[], queue?, secret? }` (events ∈ `job.pushed/started/completed/failed/progress`) |

## Live stream

`GET /events` (or `/events/queues/:q`), SSE. The **first frame is a
handshake**, `retry: 3000` followed by `data: {"connected":true,"clientId":…}`
with **no `event:` line**, so it parses with the SSE-spec default event name
`"message"`, not a literal `"connected"` event (see
[known-issues.md](known-issues.md) for the dashboard-side consequence). After
that: `job:pushed`, `job:active`, `job:completed`, `job:failed`, `job:progress`, … plus `queue:counts` and periodic `stats:snapshot` /
`health:status` system frames. Job-event payloads carry `queue`/`jobId`/
`timestamp` plus optional `error`/`progress`/`prev`/`delay`; lifecycle SSE
payloads still do not include the first-class job name. `useActivityStream` maps event
suffix → status and keeps a bounded buffer + counters + rolling throughput.
The fetch client requires `Content-Type: text/event-stream`; a proxy fallback
returning HTML/JSON with HTTP 200 is rejected instead of entering a silent
reconnect loop.

## Auth

If the server sets `AUTH_TOKENS`, enter a token in Settings for the current
browser session; `bq`/`api` send `Authorization: Bearer <token>`, and the SSE
reader (fetch-based, not `EventSource`) sends it too. `EventSource` can't carry
custom headers, which is exactly why `lib/sse.ts` exists instead of the native
API. Never put the token in a `VITE_*` value: it would be plaintext in the
public bundle.

A remote/proxied all-in-one dashboard also requires its server-side
`BUNQUEUE_TOKEN` on every `/api/*` request. Enter the same value in Settings;
the proxy validates it and forwards the Authorization header unchanged. If the
upstream enables `AUTH_TOKENS`, it must accept that value too.
