---
title: Jobs Explorer
---

# Jobs Explorer

> Route `/jobs` · source `src/pages/control/JobsPro.tsx`

![Jobs Explorer](../screenshots/jobs.png)

The Jobs Explorer is the single-job control surface: browse one queue's jobs with
server-side pagination, inspect any job, and run state-aware actions (promote,
retry, requeue, fail, cancel) on one row or on a multi-select of rows.

## What it shows

The page header reads **"Jobs Explorer — Browse, inspect, and manage individual
jobs."** and carries a **live** indicator (it polls in the background).

### Stat cards (server-wide totals)

Six compact `StatCard`s sit above the controls. They come from
`bq.overview()` (`overview.stats`) and describe the **whole server**, not just the
selected queue — the numbers do not change when you switch the queue dropdown.

| Card | Meaning | Derived from | Colour |
| --- | --- | --- | --- |
| **Total** | All jobs across every state | `totalCompleted + totalFailed + waiting + active` | neutral |
| **Waiting** | Jobs enqueued and not yet started | `stats.waiting` | amber |
| **Active** | Jobs currently being processed | `stats.active` | blue |
| **Completed** | Lifetime completed count | `stats.totalCompleted` | green |
| **Failed** | Lifetime failed count | `stats.totalFailed` | red when non-zero, else neutral |
| **Error Rate** | Failures as a share of finished jobs | `errorRate(totalCompleted, totalFailed)` → `failed / (completed + failed)`, formatted as a percentage with 2 decimals | red when `> 5%`, else green |

::: info
"Total" here is a derived sum of four fields, so it counts current waiting/active
plus lifetime completed/failed — it is not a single server counter. All six cards
render `0` until the first `overview()` response lands.
:::

### Filters and search

| Control | What it does |
| --- | --- |
| **Queue dropdown** (`Select`) | Chooses which queue's jobs to list. Options come from `bq.queuesSummary()`. Pre-selected from a `?queue=` URL param when present; otherwise it defaults to the first queue in the summary once the list arrives. Changing it resets to page 0. |
| **Status filter** (`SegmentedControl`) | `all` · `waiting` · `active` · `completed` · `failed`. Anything other than `all` is passed to the API as a `states` filter. Changing it resets to page 0. |
| **ID filter** (text input) | Placeholder *"Filter this page by ID…"* — a case-insensitive substring match on `job.id`, applied **client-side to the currently loaded page only** (it never re-queries the server). |

### Job table

A checkbox-select table with a header "select all on page" checkbox and these
columns:

| Column | Meaning |
| --- | --- |
| (checkbox) | Row selection for bulk actions. Header checkbox selects/deselects every row on the page; it reflects "all rows selected" by membership, so it un-checks correctly when the ID filter shrinks the visible rows. |
| **Job ID** | The job's `id`, monospace, truncated to ~16rem with the full id in a `title` tooltip. |
| **Status** | A `StatusBadge` for `job.state` (falls back to `waiting` when absent). |
| **Priority** | Bucketed label from `job.priority`: **HIGH** (amber) when `priority ≥ 10`, **MEDIUM** (blue) when `priority ≥ 1`, **LOW** (faint) otherwise. |
| **Created** | `formatDateTime(job.createdAt)`. |
| **Duration** | `formatDuration(completedAt − startedAt)` — only when both timestamps exist; otherwise renders `—`. |
| **Actions** | Inspect (always) plus state-gated icon buttons — see below. |

Below the table is a `Pagination` control (25 rows per page).

## What you can do

### Per-row actions

Every row always shows an **Inspect** (eye) button linking to
`/job?id=<id>` (the Job Inspector). The remaining icon buttons appear **only when
the job's state permits them** (via `actionGates`):

| Action | Icon | Effect | Confirm? |
| --- | --- | --- | --- |
| **Inspect** | eye | Opens the job in the Job Inspector | no |
| **Promote** | play | Promotes a delayed job to run now (`bq.promoteJob`) | no |
| **Retry** | refresh | Re-runs the job: an active job via `bq.retryJob` (move-to-wait), a failed/DLQ'd job via `bq.retryDlq(queue, id)` — routed automatically by `retryJobByState` | no |
| **Requeue** | refresh | Re-inserts a completed job into waiting (`bq.retryCompleted(queue, id)`) | no |
| **Fail** | close | Force-fails an active job, pushing it down the retry/DLQ path (`bq.failJob`) | **yes** — "Force-fail this active job?" |
| **Cancel** | trash | Removes a queue-resident job (`bq.cancelJob` → `DELETE /jobs/:id`) | **yes** — "Cancel this job?" |

While an action runs, that row's buttons are disabled (per-id busy tracking), and
a status line appears above the table: `"<Label> ✓"` in green on success, or
`"<Label> failed: <message>"` in red on failure. The table refetches after every
action.

### Bulk actions

Select one or more rows to reveal a bulk toolbar showing `<n> selected` and the
buttons whose action applies to **at least one** selected job:

| Bulk button | Effect | Confirm? |
| --- | --- | --- |
| **Retry selected** | Retries each eligible active/failed job | no |
| **Promote selected** | Promotes each eligible delayed job | no |
| **Requeue selected** | Requeues each eligible completed job | no |
| **Fail selected** (warning) | Force-fails each eligible active job | **yes** — "Force-fail `<n>` job(s)?" |
| **Cancel selected** (danger) | Cancels each eligible queue-resident job | **yes** — "Cancel `<n>` job(s)? This cannot be undone." |

::: tip
Bulk actions run against every selected row in parallel (`Promise.allSettled`) and
report honestly: `"<Label>: <ok> succeeded, <fail> not eligible / failed"`.
Ineligible rows in a bulk selection are rejected individually rather than skipped,
so they count toward the "not eligible / failed" tally. The confirm dialog is built
from the **actual eligible target count**, and the selection is cleared afterward.
If nothing in the selection is eligible, the toolbar shows *"No actions apply to the
selected job states."*
:::

## States & gating

**Loading** — `LoadingState` ("Loading jobs…") shows only on the first load of a
view when there are no jobs yet and no error. Background polls do not flip back to
the loading spinner.

**Empty** — the table body shows a single centered message depending on context:

- *"Select a queue."* — no queue chosen yet.
- *"No jobs found."* — a queue is selected but the page returned nothing.
- *"No jobs on this page match your ID filter."* — the ID filter excluded every
  loaded row.

**Error / offline** — on a fetch error an `OfflineBanner` with a **Retry** button
renders above the table; already-loaded rows stay visible.

**Action gating** — which per-row/bulk actions are offered comes entirely from
`src/lib/jobActions.ts::actionGates(state)`:

| Job state | Cancel | Promote | Retry | Requeue | Fail |
| --- | :---: | :---: | :---: | :---: | :---: |
| `waiting` / `prioritized` / `waiting-children` | ✅ | — | — | — | — |
| `delayed` | ✅ | ✅ | — | — | — |
| `active` | — | — | ✅ (move-to-wait) | — | ✅ |
| `failed` (DLQ) | — | — | ✅ (DLQ retry) | — | — |
| `completed` | — | — | — | ✅ | — |

`actionGates` also exposes `discard`, `setPriority`, `setDelay`, and
`moveToDelayed`, but the Jobs Explorer table does not surface those — they are used
by the Job Inspector. Cancel/promote/priority/delay are "in-queue" gates
(`waiting` / `delayed` / `prioritized` / `waiting-children`); fail/retry-active/
move-to-delayed require `active`.

## Behind the scenes

All calls use the **`bq`** client (the shape-verified control client), never the
legacy `api` client.

| Purpose | Call | Endpoint | Cadence |
| --- | --- | --- | --- |
| Queue dropdown options | `bq.queuesSummary()` | `GET /queues/summary` | polled every **30 s** |
| Stat cards | `bq.overview()` | `GET /dashboard` | polled every **10 s** |
| Job table | `bq.jobsList(queue, states, 25, page*25)` | `GET /queues/:q/jobs/list?states=…&limit=25&offset=…` | polled at the **global refresh interval** (default **3 s**, set in Settings, min 500 ms) |

Mutating calls: `bq.promoteJob` → `POST /jobs/:id/promote`; `bq.retryJob` →
`POST /jobs/:id/move-to-wait`; `bq.retryDlq` → `POST /queues/:q/dlq/retry`
(`{ jobId }`); `bq.retryCompleted` → `POST /queues/:q/retry-completed` (`{ id }`);
`bq.failJob` → `POST /jobs/:id/fail`; `bq.cancelJob` → `DELETE /jobs/:id`.

::: warning Shape gotchas
- `jobs/list` returns a **flat** `{ ok, jobs }` — there is **no `total`**, so "there
  might be a next page" is inferred purely from a full page (`jobs.length === 25`).
- Jobs have **no `name`** field and use **`startedAt` / `completedAt`** (not
  `processedOn` / `finishedOn`) — that is why Duration is `completedAt − startedAt`.
- There is **no cross-queue job-list endpoint**: jobs are always fetched one queue at
  a time (no N-queue fan-out). Each returned job is tagged with its `queue` so the
  queue-scoped retry/requeue endpoints have the value they need.
- Responses are tagged with the `queue|status|page` view they were fetched for, so
  switching any filter never renders the previous view's rows (with live action
  buttons) under the new selection for a round-trip.
:::

## Gotchas

- **The ID filter is page-local.** It matches only the 25 rows currently loaded, not
  the whole queue. To find a specific job across a large queue, prefer the Job
  Inspector's direct lookup.
- **Pagination has no true total.** The control shows the page number with **Next**
  enabled whenever a full 25-row page arrived; a partial page means you have reached
  the end. There is no "page X of Y".
- **Stat cards are server-wide.** They summarize the whole server; they will not
  match the counts of the queue you happen to have selected.
- **Selections reset on any view change.** Switching queue, status, or page clears
  the selection by design — a bulk action can never touch rows you selected under a
  different view.
- **Bulk buttons appear on partial eligibility.** A button shows if *at least one*
  selected job is eligible; ineligible rows in that selection are reported as "not
  eligible / failed" rather than silently ignored.
- Per `docs/known-issues.md`, `/jobs` (this page) is the corrected explorer — it is
  server-paginated and throttled (queue list at 30 s). The separate legacy
  `/jobs-classic` page (`Jobs.tsx`) has the always-`—` Duration column and the 3 s
  full-queue poll; that is a different page and is not what `/jobs` uses.
