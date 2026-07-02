---
title: Job Inspector
---

# Job Inspector

> Route `/job` · source `src/pages/control/JobInspector.tsx`

![Job Inspector](../screenshots/job-inspector.png)

The single-job deep dive: look up any job by its internal UUID **or** its custom / idempotency ID and drive its entire lifecycle — inspect payload, result, error, logs, timeline and backoff schedule, edit its data, and run every state-legal action — from one screen. It is deep-linkable (`/job?id=<uuid>`) and auto-loads the job on open, so every job ID elsewhere in the dashboard (Jobs, DLQ, Activity) links straight here.

## What it shows

The lookup bar is always present at the top: a **By job ID / By custom ID** dropdown, a monospace search input (with a magnifier icon and a placeholder that changes with the mode — `job id (UUID) — Enter to look up` vs `custom / idempotency id — Enter to look up`), and a **Look up** button. Below it, a single status line paints action results (green on success, red on failure).

Once a job is loaded, the body is a two-thirds / one-third grid. The left column stacks these cards; the right column is the **Actions** rail.

### Header + overview card

| Field | Meaning |
| --- | --- |
| Job ID | The internal UUID, monospace, with a copy button. |
| Queue | The queue the job belongs to (monospace, under the ID). Sourced from `job.queue`; used to route the DLQ/completed retry endpoints. |
| Status badge | Colored badge for the job's `state` (falls back to `waiting` if the state is somehow absent). |
| Priority | `job.priority`, defaults to `0`. Lower/higher semantics are the server's; the number is shown verbatim. |
| Attempts | `attempts / maxAttempts` — e.g. `0 / 3`. `maxAttempts` shows `?` if unknown. |
| Progress | `job.progress` as a percentage (`0%` if unset). |
| Created | `job.createdAt`, formatted as a local date-time. |
| Started | `job.startedAt` (the real field is `startedAt`, not `processedOn`). Blank when the job has not started. |
| Completed | `job.completedAt` (`completedAt`, not `finishedOn`). Blank until finished. |
| Duration | Computed client-side as `completedAt − startedAt`, formatted (e.g. `119ms`); blank unless both timestamps exist. |
| Custom ID | `job.customId` (`—` if none), with a copy button when present. |

### Data card

A read-only pretty-printed JSON dump of `job.data` (`JSON.stringify(value ?? null, null, 2)`), in a scrollable monospace block (max height ~16rem).

### Edit data card

A separate editable JSON textarea (`JobDataEditor`), seeded from `job.data`, with a **Save data** button. See [What you can do](#what-you-can-do).

### Result card — completed jobs only

Rendered **only** when `state === 'completed'`. The result is **not** embedded on the job object; it is fetched separately from `GET /jobs/:id/result`. If a value came back it is pretty-printed JSON; otherwise it shows `No result stored for this job.`

### Error card — failed / stacktrace jobs only

Rendered when the timeline holds a failure **or** the job has a stacktrace. It shows:

- The **last error message** (scanned backwards through `job.timeline` for the most recent `state === 'failed'` entry that carries an `error`), in red, with a sub-line `Attempt N · <timestamp>`.
- The full **stacktrace** (`job.stacktrace[]` joined by newlines) in a scrollable monospace block, when present.

### Logs card

`JobLogs` — a live viewer + writer backed by the server's per-job log store. It shows the line **count** (monospace), a **Refresh** button, a **Clear logs** button, the list of log lines (or `No log lines recorded for this job.`), and an add-line row (message input + `info/warn/error` level select + **Add**).

### Child values card — flow parents only

`JobChildren` — rendered only when `job.childrenIds` is non-empty. Collapsed by default (`Resolved return values from this flow job's children.`); expanding it lazily fetches and pretty-prints the children's resolved return values.

### Timeline card

`JobTimeline` — the attempt/state history from `job.timeline` (enqueued → started → finished, plus retries). Each entry is a row with a state badge, an optional `attempt N`, the timestamp, and — when present — the worker id and the error text (in red). Empty state: `No state transitions recorded yet.`

### Backoff card

`JobBackoff` — a client-side **preview** of the retry-delay schedule for the remaining attempts:

- If `maxAttempts <= 1`: `No retries configured (max attempts = 1)`.
- If `attempts >= maxAttempts`: `Max attempts reached — no further retries will be scheduled.`
- Otherwise a table of `Attempt k / maxAttempts → ~<delay>` for up to 10 remaining attempts, headed by the backoff type (`fixed`, or `exponential (default)` when the job has no explicit `backoffConfig`) and, if configured, the `· cap <maxDelay>`. Delays are computed as `base · 2^k` (exponential) or a flat `base` (fixed), capped at `maxDelay` (default 3,600,000 ms). A footnote notes the server applies **±50%** jitter (**±20%** for fixed) at retry time.

## What you can do

The lookup bar and the two forms below are always usable; the Actions rail is state-gated.

| Action | Effect | Confirm? |
| --- | --- | --- |
| **Look up** (button / Enter) | Fetch the job by ID or custom ID per the dropdown mode. On success the URL is rewritten to `?id=<internal-uuid>`. | No |
| **Save data** (Edit data card) | Parses the textarea locally; on valid JSON calls `PUT /jobs/:id/data`, then reloads the job. Invalid JSON shows an inline `Invalid JSON: …` and does **not** submit. | No |
| **Promote (run now)** | `POST /jobs/:id/promote` — pull a delayed job forward to run immediately. | No |
| **Retry (move to waiting)** | `POST /jobs/:id/move-to-wait` — move an active job back to waiting. | No |
| **Retry from DLQ** | `POST /queues/:q/dlq/retry { jobId }` — the only retry path for a job actually in the DLQ. | No |
| **Requeue** | `POST /queues/:q/retry-completed { id }` — re-insert a completed job into waiting (resets attempts/timestamps; this is a requeue, not a re-run-in-place). | No |
| **Move to delayed (ms)** | Inline number → `POST /jobs/:id/move-to-delayed { delay }` — park an active job as delayed. | No |
| **Discard (to DLQ)** | `POST /jobs/:id/discard` — push the job to the DLQ. | No |
| **Set priority** | Inline number → `PUT /jobs/:id/priority { priority }`. | No |
| **Set delay (ms)** | Inline number → `PUT /jobs/:id/delay { delay }`. | No |
| **Fail** | Inline text (optional reason) → `POST /jobs/:id/fail { error? }` — force-fail an active job down the retry/DLQ path. | **Yes** — `Force-fail this active job?` |
| **Cancel (delete)** | `DELETE /jobs/:id` — remove the job; clears the loaded view and the URL id. | **Yes** — `Cancel and remove this job?` |
| **Add** (Logs) | `POST /jobs/:id/logs { message, level }`, then reload the log list. Empty message is ignored; a busy guard blocks Enter auto-repeat double-posting. | No |
| **Clear logs** | `DELETE /jobs/:id/logs`. Disabled when there are no logs. | **Yes** — `Clear all logs for this job?` |
| **Refresh** (Logs) | Re-reads `GET /jobs/:id/logs`. | No |
| **Show / Hide** (Child values) | Toggles the flow-children panel; first open lazily fetches `GET /jobs/:id/children`. | No |

::: info Inline form validation
The number inputs (**Set priority**, **Set delay**, **Move to delayed**) disable their submit button while empty and send `Number(value)`. The **Fail** reason field is optional — an empty string is sent as `undefined`. The **Add log** button is disabled while the message is empty or a request is in flight.
:::

Every mutation flows through one shared `act()` helper: it runs the optional `window.confirm`, sets a busy flag (disabling the action buttons), posts the status line (`<Label> ✓` on success), and — for everything except **Cancel** — reloads the job so the view reflects the new state. **Cancel** instead clears the loaded job and the URL id (so the deep-link effect does not immediately re-fetch the just-deleted job).

## States & gating

**Lookup / page states:**

- **Loading** (no job yet): `LoadingState` with `Loading job…`.
- **Not found**: a real 404 or an HTTP-200 `{ ok:false, error:"…not found…" }` renders `EmptyState` — `Job not found` / `Check the ID, or the job may have been removed.` The stale URL id is cleared so the deep-link effect doesn't silently reload the previous job.
- **No job loaded** (initial, nothing searched): `EmptyState` — `No job loaded` / `Enter a job ID above to inspect it.`
- **Network / 5xx error**: the loaded job is **kept** (a server being down is not "job removed") and the real error message is shown on the status line.

**Action gating** — the Actions rail shows **only** the actions the server will actually accept for the current state, computed by `src/lib/jobActions.ts::actionGates(state)` (shared with JobsPro so the two surfaces never drift). "In-queue" means `waiting`, `delayed`, `prioritized`, or `waiting-children`.

| State | Actions offered |
| --- | --- |
| `waiting` / `prioritized` / `waiting-children` | Discard (to DLQ), Set priority, Set delay, Cancel (delete) |
| `delayed` | Promote (run now), Discard, Set priority, Set delay, Cancel (delete) |
| `active` | Retry (move to waiting), Move to delayed, Discard, Set delay, Fail, (no Cancel/priority — active jobs aren't queue-resident) |
| `completed` | Requeue |
| `failed` (in DLQ) | Retry from DLQ |

If none apply, the rail shows `No actions available for a job in state "<state>".` While any action is running, `busy` disables all action controls.

::: warning State ⇒ action truth table
Cancel and Set priority act **only** on queue-resident jobs; Discard and Set delay also accept an `active` job; Promote applies only to `delayed`; Fail and Move-to-delayed only to `active`; a DLQ'd (`failed`) job can only be retried via the queue-level DLQ endpoint; a `completed` job can only be requeued via the queue-level retry-completed endpoint. These mirror the server's location-based gating (`jobManagement.ts` / `dlqManager.ts`).
:::

## Behind the scenes

Everything here uses the **`bq`** client (the shape-verified one), never `api`. Endpoints called:

- Lookup: `GET /jobs/:id` (`bq.job`) or `GET /jobs/custom/:customId` (`bq.jobByCustomId`). Custom-ID lookups resolve the internal id from the response, then swap the input/URL to that UUID.
- Result: `GET /jobs/:id/result` (`bq.jobResult`) — fetched **only** for `completed` jobs, keyed by the resolved internal id, best-effort (`.catch(() => null)`).
- Logs: `GET /jobs/:id/logs`, `POST /jobs/:id/logs`, `DELETE /jobs/:id/logs`.
- Children: `GET /jobs/:id/children` (lazy, on expand).
- Actions: `POST /jobs/:id/promote`, `POST /jobs/:id/move-to-wait`, `POST /jobs/:id/discard`, `POST /jobs/:id/fail`, `PUT /jobs/:id/data`, `PUT /jobs/:id/priority`, `PUT /jobs/:id/delay`, `POST /jobs/:id/move-to-delayed`, `DELETE /jobs/:id`, plus the queue-scoped `POST /queues/:q/dlq/retry { jobId }` and `POST /queues/:q/retry-completed { id }`.

**No polling / no SSE.** The page is fully lookup-driven: it fetches once on lookup and re-fetches only after an action (via `act()`'s reload) or a manual Logs **Refresh** / Child-values expand. Deep-linking is handled by a `useEffect` on the URL `id` param that fires a lookup only when the id differs from the loaded job's id.

Response-shape gotchas (from `docs/api-mapping.md`):

- Jobs have **no `name`** field, and use **`startedAt` / `completedAt`** (not `processedOn` / `finishedOn`).
- A job's **result is not embedded** — it comes only from `GET /jobs/:id/result`, even for completed jobs; both `bq.job()` and `bq.jobResult()` are called.
- `job.timeline` **is** server-persisted (despite an in-source comment saying otherwise), but capped at `MAX_TIMELINE_ENTRIES = 20`.
- `/jobs/:id/logs` and `/jobs/:id/children` wrap their payload in `{ ok, data: { … } }`; the DLQ/completed retry endpoints are queue-scoped and flat.
- `bq.call()` throws a `BqError` on both a real 404 and an HTTP-200 `{ ok:false }` "logical failure" — which is why the lookup distinguishes "not found" (404 or `/not found/i`) from a genuine network/5xx error.

## Gotchas

- **Backoff is an approximation.** The schedule is computed client-side without jitter; the server applies **±50%** (±20% for fixed) at retry time, capped at 60m — treat the numbers as "~". A `null` `backoffConfig` means the job used the plain SDK backoff path, rendered here as `exponential (default)`, not "no backoff".
- **Timeline truncation.** Very retry-heavy jobs show only the last 20 transitions; older attempts are gone. The Error card's "last error" is likewise only as old as the retained timeline.
- **Requeue ≠ re-run in place.** For a completed job, **Requeue** resets `attempts` / `startedAt` / `completedAt` / `runAt` and re-inserts it into waiting — a fresh run, not a replay of the stored result.
- **Custom-ID result timing.** For a custom-ID lookup the internal id is only known after the job comes back, so the result fetch happens after resolution and is best-effort — a missing result silently renders `No result stored for this job.` rather than an error.
- **Cancelling an already-terminal job throws.** `bq`'s strict mode turns HTTP-200 `{ ok:false }` into an error, so an illegal action surfaces on the red status line rather than silently no-op'ing. The action rail already prevents most of these by only showing state-legal actions (see `docs/known-issues.md` on strict-mode behavior).
- **Concurrent lookups are guarded.** A sequence counter (`lookupGen`) ensures the last-started lookup wins, so hammering Enter can't let a slow response clobber a newer one.
- This page is the **`bq`-based** inspector; the classic `/jobs-classic` and `Dlq.tsx` surfaces have separate, documented limitations (see `docs/known-issues.md`) and are not this page.
