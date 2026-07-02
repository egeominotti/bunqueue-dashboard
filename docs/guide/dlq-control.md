---
title: DLQ Control
---

# DLQ Control

> Route `/dlq-control` · source `src/pages/control/DlqControl.tsx`

![DLQ Control](../screenshots/dlq-control.png)

The single-queue operations view of the **Dead Letter Queue (DLQ)**: pick one queue, inspect every job that exhausted its retries, and replay or discard those jobs — one at a time or in bulk. Every request goes through the `bq` client to the bunqueue HTTP API.

## What it shows

The header reads **"Dead Letter Queue"** with the subtitle *"Inspect and replay jobs that exhausted their retries."* and a **live** indicator (the header's `live` flag), signalling the table auto-refreshes.

Below the header sits a control row and, under it, the entry table.

**Queue selector** — a dropdown (`<Select aria-label="Queue">`) listing every queue. Each option renders the queue name plus its DLQ count in parentheses when non-zero, e.g. `image-resize (3)`; queues with an empty DLQ show just the name. The list is sourced from `bq.queues()` and refreshed on its own 30-second poll. On first load the page auto-selects the **first queue that actually has DLQ entries** (`dlq > 0`); if no queue has any, it falls back to the first queue in the list.

**Entries stat card** — a compact `StatCard` labelled **Entries** showing the selected queue's total DLQ size (`data.total`, formatted with thousands separators). It is tinted **red** (`tone="red"`) when the total is non-zero and neutral (`default`) when the DLQ is empty.

**Action feedback** — after any action a short message appears inline next to the stat card: **green** on success (e.g. `Retried 3 entries`, `Purged 1 entry` — singular/plural is chosen from the returned `count`) or **red** with the error text on failure.

**Entry table** — a paginated table (25 rows per page) rendered from the current page of DLQ entries:

| Column | Meaning |
| --- | --- |
| **Job ID** | The dead-lettered job's id (`e.job.id`), monospaced. The DLQ entry has no top-level `id` — the id is nested under `job`. |
| **Reason** | Why the job was dead-lettered (`e.reason`), shown as a red badge — typically a value like `max_attempts_exceeded`. |
| **Error** | The last error message (`e.error`), truncated to a max width; renders `—` when the error is empty/`null`. |
| **Attempts** | How many times the job ran. Uses `e.job.attempts`, falling back to the length of the `e.attempts[]` attempt-record array, then `—` if neither is present. Right-aligned. |
| **Entered** | When the job landed in the DLQ (`e.enteredAt`), shown as relative time (e.g. "12m ago"). Right-aligned. |
| *(actions)* | A per-row **Retry** icon button (see below). |

Rows are keyed by `job.id + enteredAt` and highlight on hover.

At the bottom, a **Pagination** control (25 per page, labelled "entries") appears whenever data is loaded, driven by `data.total`.

## What you can do

| Action | Effect | Confirm? |
| --- | --- | --- |
| **Retry all** (header) | Replays **every** DLQ entry for the selected queue via `bq.retryDlq(queue)` (no `jobId`). | Yes — `Retry all <total> DLQ entries for "<queue>"?` |
| **Purge** (header, danger) | Permanently deletes **all** DLQ entries for the queue via `bq.purgeDlq(queue)`. | Yes — `Purge all <total> DLQ entries for "<queue>"?` |
| **Retry one** (per row) | Replays a single job via `bq.retryDlq(queue, e.job.id)`. | **No** — one click fires it immediately |
| **Switch queue** | Selecting another queue in the dropdown loads that queue's DLQ and resets to page 0. | No |
| **Paginate** | Move through pages of 25 entries. | No |

All three mutating actions run through a shared `run()` helper that: optionally shows a `window.confirm` gate, sets a **busy** flag (disabling the buttons and the per-row icons while in flight), reports the returned `count` as green success feedback, and refetches the table. On error it surfaces the thrown message in red instead.

::: warning Per-row Retry has no confirmation
Unlike **Retry all** and **Purge**, the per-row refresh icon fires `retryDlq` for that single job with a single click and no `confirm()` dialog. There is no undo.
:::

## States & gating

- **Loading** — `LoadingState` with "Loading DLQ…" shows only on the very first fetch (`loading && !data && !error`); subsequent background polls refresh in place without a spinner.
- **Empty** — when the selected queue has no entries, an `EmptyState` (DLQ icon) reads *"Dead letter queue is empty"* with the hint *"Failed jobs that exhaust their retries land here."* The **Entries** card shows `0` in neutral tone.
- **Error / offline** — if the fetch fails, an `OfflineBanner` renders above the controls with a **Retry** button that calls `refetch()`. The last successfully loaded rows stay on screen.
- **Button gating** — **Retry all** and **Purge** are disabled when no queue is selected (`!queue`) or an action is in flight (`busy`). Per-row Retry icons are disabled while `busy`.
- **Job-state gating** — this page does **not** use `src/lib/jobActions.ts::actionGates`. Everything in the DLQ is already in the `failed` state, and the only operation offered is retry-from-DLQ (`POST /queues/:q/dlq/retry`), which per `docs/api-mapping.md` is the only valid retry path for a job that is actually in the DLQ table. There is no per-job Cancel/Discard/Promote here — those live on the job inspector for non-DLQ'd jobs.
- **Stale-view protection** — the fetch result is tagged with its `queue` and `page`; the table only renders when the tag matches the current selection, so switching queue can never leave the previous queue's rows visible (which would make a per-row Retry fire against the wrong queue). When the DLQ shrinks (from a retry-all/purge here, or an external change) the page index auto-clamps to the new last page so a stale offset can't render "empty" while entries remain.

## Behind the scenes

All calls use the `bq` client (never the legacy `api`):

- `GET /dashboard/queues?limit=…&offset=…` — `bq.queues()`, the queue-selector source, polled every **30 s**.
- `GET /queues/:q/dlq?limit=25&offset=<page*25>` — `bq.dlq(queue, 25, page*25)`, the table source. Polled at the connection store's global refresh cadence (**default 3 s**, configurable, floored at 500 ms). Response shape is **flat**: `{ ok, entries[], total }` — no `data` wrapper (see `docs/api-mapping.md`).
- `POST /queues/:q/dlq/retry` with body `{ jobId? }` — `bq.retryDlq()`. Omitting `jobId` retries every entry; including it retries one. Returns `{ ok, count }`; the page reports `count` in its feedback.
- `POST /queues/:q/dlq/purge` — `bq.purgeDlq()`, returns `{ ok, count }`.

::: info Shape gotchas
A DLQ entry is `{ job, enteredAt, reason, error, attempts[] }` — the job (and thus the id/attempts) is **nested** under `job`, with no top-level `id` or `name`. The `bq` client's `call()` throws on an HTTP-200 response carrying `{ ok: false }`, so a logical failure on retry/purge surfaces as the red error message rather than a silent no-op.
:::

## Gotchas

- **Three DLQ pages coexist on purpose.** `/dlq` (DLQ Pro) is the cross-queue view with filters; **this page** is the focused single-queue operations view; `/dlq-classic` is off-nav and **known-broken on non-empty DLQs** — avoid it. Per `docs/known-issues.md`, the classic `Dlq.tsx` models the wrong entry shape and crashes rendering a non-empty DLQ; `DlqControl` (and `DlqPro`) use the corrected `DlqEntryFull` from `bqTypes.ts` and read `e.job.id`, so they are unaffected.
- **Retry all replays the whole queue's DLQ**, not just the visible page — the confirmation deliberately names the full `total`, which may exceed the 25 rows on screen.
- **Purge is irreversible.** It deletes entries server-side; there is no soft-delete or recovery from the dashboard.
- **Two independent poll clocks.** The selector count (30 s) and the table (default 3 s) refresh separately, so a queue's parenthesised count in the dropdown can briefly lag the live **Entries** card after an action.
- Historically `DlqControl` also fetched `dlqStats`, whose failure blanked the whole page; that dependency was **removed** (see `docs/known-issues.md`) — the page now relies only on the entry list's `total`.
