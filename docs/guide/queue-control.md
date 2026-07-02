---
title: Queue Control
---

# Queue Control

> Route `/queue-control` · source `src/pages/control/QueueControl.tsx`

![Queue Control](../screenshots/queue-control.png)

The Pro operations console for a **single** queue. Pick a queue from the dropdown and you get its live counts plus every per-queue lever the bunqueue HTTP API exposes — pause/resume, drain, delayed-job promotion, completed-job retry, destructive cleanup, rate limit, concurrency, stall detection and DLQ policy — all on one page. Every call goes through the `bq` client.

## What it shows

At the top: a **queue picker** (`<Select>`, fixed width) listing every queue by name, a live **status dot**, and an inline **last-action message**. The picker's option list comes from a slow 30 s poll of `bq.queues()`; on first load the page auto-selects the first queue in that list. The `PageHeader` carries a "live" badge.

The status dot and everything below only render once the selected queue's detail has loaded.

| Field | Meaning |
|-------|---------|
| Status dot | `Active` (green) or `Paused` (amber), driven by `detail.paused` for the selected queue. |
| Last-action message | Inline text next to the picker after any action: green on success, red on failure. Success shows the action label plus the server's `count` when the endpoint returns one (e.g. `Drained: 120`, `Cleaned: 47`) or a `✓` when it does not. Failure shows the thrown error's message. |

Below that, a responsive grid (3 columns on mobile, 6 on `md+`) of six **compact count cards**, in this fixed order, each formatted with thousands separators via `formatNumber`:

| Card | Meaning |
|------|---------|
| `waiting` | Jobs queued and ready to run. |
| `active` | Jobs currently being processed. |
| `completed` | Jobs that finished successfully. |
| `failed` | Jobs that exhausted retries (dead-lettered). |
| `delayed` | Jobs scheduled to run later. |
| `paused` | Jobs held because the queue is paused. |

The numbers come straight from `detail.counts[k]` in the `bq.queueDetail(queue, false)` response (fetched with `includeJobs=false`, so no job list is pulled).

Then the operational cards:

- **Lifecycle** card — pause/resume, drain, retry-completed, promote-delayed and clean controls (see below).
- **Rate limit** and **Concurrency** cards, side by side on `lg+`.
- **Stall detection** and **DLQ policy** forms, side by side on `lg+`. These render only if the server returned a stall/DLQ config for the queue; both fetches are wrapped in `.catch(() => null)`, so a queue missing one simply hides that form. They are pre-filled from the server's current config.

## What you can do

All mutating actions run through one shared `run(label, fn, confirmMsg?)` helper: it optionally shows a `window.confirm`, sets a global `busy` flag (which disables the action buttons), calls the endpoint, then reports the outcome inline and `refetch`es the queue detail.

| Action | Card | Effect | Confirm? |
|--------|------|--------|----------|
| **Pause** / **Resume** | Lifecycle | Toggles `detail.paused`; the single button swaps label/variant based on current state (`bq.pause` / `bq.resume`). | No |
| **Drain** | Lifecycle | Removes waiting jobs from the queue; reports the server's `count`. | **Yes** — `Drain waiting jobs from "<queue>"?` |
| **Retry completed** | Lifecycle | Requeues completed jobs back into waiting; reports `count`. | No |
| **Promote delayed** | Lifecycle | Promotes delayed jobs to waiting now. The `Promote N` input (placeholder `all`) optionally caps it to the first *N*; blank = all. Reports `count`. | No |
| **Clean** | Lifecycle | Permanently deletes completed/failed jobs matching `Grace (ms)` (default `0`) and `Limit` (default `1000`); reports `count`. | **Yes** — `Permanently delete up to <limit> completed/failed jobs older than <grace>ms from "<queue>"?` |
| **Set** rate limit | Rate limit | Sets max jobs per window (`Limit` input, placeholder `max per window`). Button disabled while empty. | No |
| **Clear** rate limit | Rate limit | Removes the rate limit. | No |
| **Set** concurrency | Concurrency | Sets max in-flight jobs (`Concurrency` input, placeholder `max in-flight`). Button disabled while empty. | No |
| **Clear** concurrency | Concurrency | Removes the concurrency cap. | No |
| **Save** stall detection | Stall detection | Persists the stall config (see form below). | No |
| **Save** DLQ policy | DLQ policy | Persists the DLQ config (see form below). | No |

### Stall detection form

Fields: an `enabled` toggle, and three numeric inputs — **Stall interval (ms)**, **Max stalls**, **Grace period (ms)**. On **Save**, all three numeric fields are coerced with `toNum`; if any is blank or non-numeric the save is rejected with the inline error `All numeric fields must be filled in` (no request is sent). A successful save shows `Saved ✓` for 2 s (and bubbles up `Stall config saved ✓` to the top-level message).

### DLQ policy form

Fields: an `auto-retry` toggle, and four numeric inputs — **Retry interval (ms)**, **Max auto-retries**, **Max age (ms)**, **Max entries**. On **Save**, `Retry interval`, `Max auto-retries` and `Max entries` are required (same `All numeric fields must be filled in` guard). **Max age is nullable**: a blank field means *no max age* (`null`) and is accepted; it is not treated as invalid. Success shows `Saved ✓` for 2 s and bubbles `DLQ config saved ✓`.

::: tip Live-typing safe
Both forms adopt server values into local state only when the serialized config **value** actually changes (`useSyncedConfig`), not on every 3 s poll. This preserves your in-progress edits across background refreshes while still switching to a new queue's config. Numeric inputs are held as strings mid-edit so clearing a field doesn't snap to `0`.
:::

## States & gating

- **Loading:** while the first queue-detail fetch is in flight (and there's no cached data and no error), a `LoadingState` spinner shows.
- **No queue selected / no detail:** if there's no `detail` and no error, the page shows `Select a queue.` (This is also the state before the auto-select lands, or if the picked queue has no detail.)
- **Offline / error:** an `OfflineBanner` with a **Retry** button (calls `refetch`) renders above the content whenever the detail fetch errors.
- **Busy:** while any action is running, `busy` is `true` and every Lifecycle/Rate limit/Concurrency button is disabled. The Set buttons are additionally disabled while their input is empty. The Save buttons in the forms are disabled only while that form is `saving`.
- **Stale-queue guard:** the fetched payload is tagged with the queue it was fetched for; `data` is only used when `raw.queue === queue`, so a queue switch never renders — or saves — queue A's config under queue B's name for a round-trip. The forms are also keyed by queue (`key={queue}`), so they remount on switch.

This page operates on the **queue**, not on individual jobs, so the per-job state→action gating in `src/lib/jobActions.ts` does not apply here (that governs the Job Inspector / Jobs Pro surfaces). The queue-level `retry-completed` used here is exactly the completed-job requeue path that `jobActions.ts` documents as *only* reachable at the queue level.

## Behind the scenes

Client: **`bq`** only. Two independent polls:

- Queue picker — `bq.queues()` every **30 s** (`GET /dashboard/queues?limit=500&offset=0`). The set of queues changes rarely, so it's polled slowly.
- Selected queue — a combined fetch on the **global live cadence** (default **3 s**, configurable in Settings, floor 500 ms), running three calls in parallel:
  - `bq.queueDetail(queue, false)` → `GET /dashboard/queues/<queue>?includeJobs=false` (counts + `paused`).
  - `bq.getStallConfig(queue)` → `GET /queues/<queue>/stall-config` (returns `{ ok, config }`).
  - `bq.getDlqConfig(queue)` → `GET /queues/<queue>/dlq-config` (returns `{ ok, config }`).

Mutating endpoints:

| Action | Endpoint |
|--------|----------|
| Pause / Resume | `POST /queues/<queue>/pause` · `POST /queues/<queue>/resume` |
| Drain | `POST /queues/<queue>/drain` → `{ ok, count }` |
| Retry completed | `POST /queues/<queue>/retry-completed` → `{ ok, count }` |
| Promote delayed | `POST /queues/<queue>/promote-jobs` (body `{ count }` only when N given) → `{ ok, count }` |
| Clean | `POST /queues/<queue>/clean` (body `{ grace, limit }`) → `{ ok, count }` |
| Set / Clear rate limit | `PUT /queues/<queue>/rate-limit` body `{ limit }` · `DELETE /queues/<queue>/rate-limit` |
| Set / Clear concurrency | `PUT /queues/<queue>/concurrency` body `{ concurrency }` · `DELETE /queues/<queue>/concurrency` |
| Save stall config | `PUT /queues/<queue>/stall-config` body `{ config }` |
| Save DLQ config | `PUT /queues/<queue>/dlq-config` body `{ config }` |

::: info Shape gotchas
The rate-limit endpoint takes `{ limit }` (not `{ rate }`) — see `docs/api-mapping.md`. Stall/DLQ config reads are flat `{ ok, config }`, and writes wrap the payload as `{ config }`. `bq`'s `call()` throws on any HTTP-200-with-`{ ok:false }`, so a logical failure (e.g. an invalid config) surfaces as the red inline error, not a silent no-op.
:::

## Gotchas

- **Drain and Clean are destructive.** Drain removes waiting jobs; Clean permanently deletes completed/failed jobs (up to `Limit`, older than `Grace ms`). Both are behind a `window.confirm` that names the queue and, for Clean, the limit and grace. There is no undo.
- **Switching queue discards unsaved form edits.** The Stall/DLQ forms remount per queue (`key={queue}`) — a switch throws away anything you typed but didn't save. Separately, an *external* config change to the current queue can overwrite your in-progress edits when the server's serialized value differs from what the form last adopted.
- **Empty-field validation is client-side only** and applies to the two config forms, not to the rate-limit/concurrency setters (those only disable Set while the field is empty). DLQ **Max age** is the one numeric field where blank is valid (means "no max age").
- **`docs/pages.md`** historically flagged the Stall/DLQ forms as "not resyncing on queue switch"; the current code fixes this via per-queue remounting, and `docs/known-issues.md` lists the cross-queue config-write bug as **fixed**.
- The last-action message is a single shared line — a new action clears the previous result, and a config-form save overwrites (and is overwritten by) a lifecycle action's message.
