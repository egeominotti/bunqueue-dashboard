---
title: Dead Letter Queue
---

# Dead Letter Queue

> Route `/dlq` · source `src/pages/control/DlqPro.tsx`

![Dead Letter Queue](../screenshots/dlq.png)

The Dead Letter Queue (DLQ) is where jobs land after they have failed and exhausted every retry. This page is the cross-queue DLQ console: it summarizes how many failed jobs exist across all queues, lets you drill into one queue at a time, and gives you the tools to inspect, retry, or purge those failures.

## What it shows

The page has four regions, top to bottom: a row of four stat cards, a "DLQ by queue" tile grid, a filter/action toolbar, and the entries table.

### Stat cards (four across)

| Field | Meaning |
| --- | --- |
| **Total in DLQ** | The grand total of dead-letter entries **across all queues**, computed client-side by summing each queue's `dlq` count (`queues.reduce((a, q) => a + q.dlq, 0)`). The pill in the card's top-right reads **Healthy** (green) when this total is `0`, otherwise **Attention** (red); the big number itself is green at zero and red otherwise. This is the only card that is not scoped to the selected queue. |
| **Top Reason** | The single most common failure reason for the **currently selected queue**, derived from `stats.byReason` (the reason with the highest count). Shows `Select a queue` when nothing is selected, or `No failures` if the selected queue's stats report no reasons. |
| **Pending Retry** | `stats.pendingRetry` for the selected queue — entries queued for automatic retry (via the queue's DLQ auto-retry policy) but not yet retried. Shows `—` until stats load; the sub-label reads "in this queue" when a queue is selected, otherwise "awaiting retry". |
| **Failure Types** | The number of **distinct** failure reasons for the selected queue that have a non-zero count (`reasons.length`, i.e. `Object.keys(stats.byReason)` filtered to `> 0`). Sub-label: "distinct reasons". Shows `—` until stats load. |

::: info Scope
Only **Total in DLQ** is global. The other three cards reflect the queue you have selected in the toolbar; before you pick a queue they show placeholders (`Select a queue` / `—`).
:::

### DLQ by queue grid

A card of clickable tiles, one per queue **that currently has at least one DLQ entry** (`q.dlq > 0`), sorted by DLQ size descending. Queues with an empty DLQ are intentionally hidden here to cut noise. Each tile shows the queue name (monospace) and its DLQ count as a large red number. Clicking a tile selects that queue (and resets the reason filter and page — see below). The currently-selected tile is highlighted with an accent border. The whole card is hidden when no queue has any entries.

### Entries table

Once a queue is selected and has entries on the current page, they render as a table with these columns:

| Column | Meaning |
| --- | --- |
| **Job ID** | The failed job's ID (`e.job.id`, monospace), rendered as a link to the Job Inspector at `/job?id=<encoded id>`. There is **no job name** — bunqueue jobs have no `name` field. |
| **Reason** | The failure reason (`e.reason`) shown as a red badge (e.g. `max_attempts_exceeded`). |
| **Error** | The error message text (`e.error`), truncated to a max width; renders `—` when the entry has no error string. |
| **Entered** | When the job entered the DLQ (`e.enteredAt`), shown as a relative time (e.g. "12m ago"). |
| _(unlabeled)_ | A per-row Retry icon button (circular-arrow icon) in the last column. |

The underlying DLQ entry shape is `{ job, enteredAt, reason, error, attempts[] }` — the job is **nested** under `job`, there is no top-level `id`/`name`. Optional fields on the entry (`retryCount`, `lastRetryAt`, `nextRetryAt`, `expiresAt`, `attempts[]`) exist in the type but are not displayed by this page.

## What you can do

| Action | Effect | Confirm? |
| --- | --- | --- |
| **Select a queue** (dropdown or tile) | Loads that queue's DLQ page + stats; resets reason filter to "all" and page to 0. Dropdown options show the queue name with its DLQ count in parentheses when non-zero. | No |
| **Filter by reason** | Dropdown of reasons present in the selected queue's stats. Filters the **currently loaded page** only. | No |
| **Sort** | Newest First / Oldest First, by `enteredAt`. Sorts the **currently loaded page** only; labels gain "(this page)" when the queue spans more than one page. | No |
| **Filter this page by job ID** | Free-text input; case-insensitive substring match on `job.id`, on the **currently loaded page** only. | No |
| **Retry All** | `bq.retryDlq(queue)` — retries every DLQ entry in the selected queue. Reports "Retried N entries". Disabled with no queue selected or while busy. | Yes — `Retry all for "<queue>"?` |
| **Purge All** | `bq.purgeDlq(queue)` — permanently deletes every DLQ entry in the selected queue (danger-styled button). Reports "Purged N entries". Disabled with no queue selected or while busy. | Yes — `Purge all for "<queue>"?` |
| **Retry one entry** (per-row icon) | `bq.retryDlq(queue, job.id)` — retries that single job. Reports "Retried N entries". Disabled while busy. | Yes — `Retry job <first 8 chars>… from "<queue>"?` |
| **Open a job** | Clicking the Job ID opens the job in the Job Inspector (`/job?id=…`). | No |
| **Paginate** | Pager steps through the DLQ 25 entries at a time (`PAGE_SIZE = 25`). | No |

::: warning Retry vs. Purge
Retry moves entries back out of the DLQ so they can run again. **Purge is destructive and irreversible** — it deletes the failed entries outright. Both operate on the whole selected queue at once and are gated behind a `window.confirm` dialog.
:::

After any Retry/Purge, a one-line status message appears below the toolbar (green on success, red on error), and the page refreshes both the selected queue's entries (`refetch`) and the global queue list (`refetchQueues`) so the grand total, the by-queue grid, and the dropdown counts all update.

## States & gating

- **Loading:** while the first fetch for a selected queue is in flight and there is no data yet (and no error), a `LoadingState` "Loading DLQ…" is shown.
- **No queue selected:** an `EmptyState` prompts "Select a queue" with a hint to choose one from the dropdown. The stat cards (except Total) and the entries area stay in placeholder mode.
- **Empty DLQ (queue selected):** `EmptyState` "No dead letter entries" — "This queue has no dead letter entries."
- **Filter matches nothing on this page:** `EmptyState` "No matches on this page", explaining the filter is page-scoped and to use the pager to check other pages.
- **Error / offline:** an `OfflineBanner` with a Retry button renders above the cards when the fast fetch errors.
- **Disabled controls:** Retry All / Purge All are disabled when no queue is selected or an action is in flight (`busy`); per-row Retry is disabled while `busy`.

### Job-action gating (context)

This page does **not** use the generic per-state job-action gates in `src/lib/jobActions.ts`. A job that is actually in the DLQ has state `failed`, and per `actionGates` the only legal action for a `failed` job is `retryDlq` — the queue-level DLQ retry endpoint. Generic actions (cancel, discard, promote, requeue, set-priority/delay, fail, move-to-delayed) do **not** apply to DLQ'd jobs. That is exactly why this page's only mutations are queue-level Retry All / Purge All and per-entry Retry.

## Behind the scenes

All calls use the **`bq`** client (the shape-verified client). Two independent polls run:

- **Queue list — slow poll (10s):** `bq.queues()` → `GET /dashboard/queues?limit=…&offset=…`. Provides every queue's `dlq` count for the grand total, the by-queue grid, and the dropdown. Polled on a fixed 10 000 ms cadence (`intervalMs: 10000`).
- **Selected queue — fast poll:** in parallel, `bq.dlq(queue, 25, page*25)` → `GET /queues/:q/dlq?limit=25&offset=…` (returns `{ ok, entries[], total }`, **flat**, no `data` wrapper) and `bq.dlqStats(queue)` → `GET /queues/:q/dlq/stats` (returns `{ ok, stats }`, flat). The stats call is wrapped in `.catch(() => null)` so a stats failure blanks the four derived cards but still renders the table. The fast poll uses the global refresh interval from the connection store (default **3000 ms**, min 500 ms, adjustable in Settings).

Mutations:

- **Retry (all or one):** `bq.retryDlq(queue, jobId?)` → `POST /queues/:q/dlq/retry` with body `{ jobId }` when retrying one entry, or **no body** to retry every entry. Returns `{ ok, count }`.
- **Purge:** `bq.purgeDlq(queue)` → `POST /queues/:q/dlq/purge`. Returns `{ ok, count }`.

The `raw`/`data` result is tagged with the current `queue` + `page`; the component only renders it when the tag matches the live selection (`raw.queue === queue && raw.page === page`). This prevents a stale previous-queue page from staying on screen after a switch — which would otherwise make a per-row Retry fire against the wrong queue. Response-shape note from `docs/api-mapping.md`: `/queues/:q/dlq` and `/dlq/stats` are flat (`{ ok, … }`), unlike the wrapped `{ ok, data }` endpoints. `bq.ts`'s `call()` throws on HTTP-200-with-`{ok:false}`, so a logical failure on retry/purge surfaces as the red status message.

## Gotchas

- **Reason filter, job-ID search, and sort are page-scoped.** The server paginates the DLQ but exposes no reason/id filter and no server-side sort, so these controls only act on the 25 entries currently loaded. When a queue spans more than one page, the sort options are labeled "(this page)" and an empty filter result tells you to use the pager to check other pages. Confirmed in `docs/user-guide.md`.
- **The four derived cards depend on `/dlq/stats`.** If that call fails it is swallowed (`.catch(() => null)`), so Top Reason / Pending Retry / Failure Types fall back to placeholders while the table still works. Only **Total in DLQ** is independent (it comes from the queue-list poll).
- **"Total in DLQ" is a client-side sum** of every queue's `dlq` count from the slow 10s poll, so it can lag a just-performed retry/purge by up to that interval even though the page triggers an immediate `refetchQueues`.
- **Purge is permanent.** There is no undo; the confirm dialog is the only safeguard.
- **Not the classic `/dlq-classic` page.** An older `Dlq.tsx` renders a shape the server doesn't return and crashes on a non-empty DLQ; it is off-nav. This page (`DlqPro`) uses the corrected `DlqEntryFull` from `bqTypes.ts` and reads `e.job.id`, so it is unaffected (see `docs/known-issues.md`).
- **The page keeps its `Pagination` control mounted** when a queue is selected and data is present, per a fix noted in `docs/known-issues.md`, so navigation stays stable across refreshes; the page auto-clamps to the last valid page if the DLQ shrinks underneath you.
