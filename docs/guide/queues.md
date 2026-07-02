---
title: Queues
---

# Queues

> Route `/queues` · source `src/pages/control/QueuesOverview.tsx`

![Queues](../screenshots/queues.png)

The fleet view of every queue on the connected bunqueue server: per-state counts for each queue, four fleet-wide summary cards, a name filter, client-side pagination, and a one-click pause/resume switch on every row. It is built for incident triage — pause is the first control you reach for, so it lives on each row rather than one level deep on the detail page.

## What it shows

The page header reads **Queues** with the description **`{n} queues`** (the total count of queues returned by the summary call) and a **Live** badge indicating the data polls in the background.

### Summary cards (fleet totals)

Four compact `StatCard`s across the top. Each is a sum over **all** queues (not the filtered/searched subset — the totals are derived from the full `all` list, before the search filter is applied):

| Card | Meaning | Source / color |
| --- | --- | --- |
| **Waiting** | Sum of `counts.waiting` across every queue — jobs enqueued and awaiting a worker | amber tone |
| **Active** | Sum of `counts.active` — jobs currently being processed | blue tone |
| **Failed** | Sum of `counts.failed` — jobs that exhausted retries | red tone when > 0, neutral (default) when 0 |
| **Paused** | Count of **queues** whose `paused` flag is true (one per paused queue, not a job count) | amber tone when > 0, neutral when 0 |

::: info
The **Paused** card counts paused *queues*, not paused jobs — it increments by 1 for each queue whose status pill reads "Paused". The other three cards are job counts.
:::

All numbers are rendered through `formatNumber`, so large values are thousands-formatted (e.g. `41,300`).

### The queues table

One row per queue, sorted alphabetically by name (`localeCompare`). Columns:

| Column | Meaning | Color / formatting |
| --- | --- | --- |
| **Queue** | Queue name, with a queue icon; a real keyboard-focusable link to `/queues/:name` | fg, hover accent |
| **Waiting** | `counts.waiting` | amber/`text-warning`, right-aligned tabular |
| **Active** | `counts.active` | blue (`text-blue-400`) |
| **Completed** | `counts.completed` | green (`text-success`) |
| **Failed** | `counts.failed` | red (`text-danger`) when > 0, muted grey when 0 |
| **Delayed** | `counts.delayed` — jobs scheduled to run later | muted grey |
| **Status** | Pill: green "Active" or orange "Paused", from the queue's `paused` flag | emerald pill / orange pill with a filled dot |
| **Actions** | Pause/Resume icon button + a right-arrow affordance | see below |

All numeric columns are right-aligned with tabular numerals (`tnum`) so figures line up column-wise, and every value passes through `formatNumber`.

The **Actions** cell holds an `IconButton` — an amber **pause** icon when the queue is active, a green **play** icon when it is paused — followed by a right-pointing arrow (`IconArrowRight`) that fades in on row hover to signal the row is clickable into the detail page.

## What you can do

| Action | Effect | Confirm? |
| --- | --- | --- |
| **Pause a queue** | Click the amber pause icon → `bq.pause(name)`; the row's button disables while in flight, then the list refetches and a success message appears above the table | No confirm gate |
| **Resume a queue** | Click the green play icon → `bq.resume(name)`; same in-flight/refetch/message flow | No confirm gate |
| **Search queues** | Type in the filter box; case-insensitive substring match on the queue name; resets to page 1 on each keystroke | — |
| **Open a queue's detail** | Click anywhere on a row (pointer convenience) or the queue-name link (keyboard/focus access) → navigates to `/queues/:name` (name URL-encoded) | — |
| **Page through queues** | `Pagination` control at 15 queues per page (`PAGE_SIZE = 15`) | — |
| **Retry after an outage** | The offline banner's Retry button re-runs the poll | — |

::: warning
Pause and resume are **not** behind a `window.confirm` gate on this page — a single click acts immediately. (Destructive actions like drain/obliterate live on the per-queue control page, not here.)
:::

Feedback after a pause/resume renders as a single line above the table:

- Success: green text, `"{name} paused ✓"` or `"{name} resumed ✓"`.
- Failure: red text with the thrown error's `message`.

While a queue's toggle is in flight, only **that** row's button is disabled (tracked in a per-name `busy` set); other rows stay interactive.

## States & gating

- **Loading (first load):** while the first poll is in flight and there is no data and no error yet, the whole page is replaced by a `LoadingState` reading **"Loading queues…"**. Subsequent background refreshes keep the current table on screen (no flicker, no re-mount).
- **Empty — no queues:** the table body shows a single centered row, **"No queues yet."**
- **Empty — no search match:** with a non-empty filter that matches nothing, the same cell reads **"No queues match your search."**
- **Error / offline:** on a failed poll an `OfflineBanner` with a **Retry** button renders above the cards; the last good data (if any) stays visible beneath it.
- **Action failure:** a failed pause/resume does not remove the row — it surfaces the error as the red message line and still refetches.
- **Button disabling:** a row's pause/resume button is disabled only while that specific queue's request is pending.

This page has no job-state action gating (that logic in `src/lib/jobActions.ts` applies to the job pages, not here). The only per-row control is pause/resume, whose icon is chosen purely from the queue's `paused` flag.

## Behind the scenes

- **Data:** a single `GET /queues/summary` per poll via `bq.queuesSummary()` — one round-trip returns every queue's full counts, so there is **no per-queue fan-out** even with many queues. Filtering, sorting, and pagination are all client-side.
- **Response shape gotcha:** `/queues/summary` returns a **bare array** — `[{ name, paused, counts:{ waiting, active, completed, failed, delayed } }]` — with **no `{ ok, data }` envelope at all** (per `docs/api-mapping.md`). The typed client (`QueueSummaryFull[]`) handles this directly.
- **Pause / resume:** `bq.pause(name)` → `POST /queues/:q/pause`, `bq.resume(name)` → `POST /queues/:q/resume`. Both go through `bq.ts`'s `call()`, which throws on an HTTP-200 `{ ok: false }` body too — so a logical server-side failure surfaces as the red error message, not a false success.
- **Polling cadence:** `usePolledData` polls at the global `refreshMs` from the connection store (**default 3000 ms**, adjustable in Settings, floored at 500 ms). It uses a recursive `setTimeout` (not `setInterval`), so at most one fetch is in flight at a time, and it **pauses while the browser tab is hidden**, refetching immediately when the tab regains focus.
- **Client used:** everything on this page uses **`bq`** (the shape-verified client), consistent with the project's "new work uses `bq`" rule. No `api.*` calls.

## Gotchas

- **Summary cards ignore the search filter.** The four totals always sum *all* queues, never the filtered subset — so the numbers won't change as you type in the search box. This is intentional (fleet totals), but easy to misread.
- **"Paused" card is a queue count, not a job count.** It tallies queues in the paused state; it says nothing about how many jobs are paused.
- **Page clamps, doesn't reset.** If the active filter shrinks the list below the current page offset, the page index is clamped to the last valid page (`safePage`) rather than throwing away your position — but note the search box itself does reset to page 1 on every keystroke.
- **No confirm on pause/resume.** A mis-click pauses a live queue instantly; use the row's Status pill to confirm the resulting state (the list refetches after each toggle).
- **All counts are as-of-last-poll.** With the default 3 s cadence and polling suspended on a hidden tab, a busy queue's numbers can lag reality by a few seconds; the header's **Live** badge indicates the data is polled, not streamed.
- No page-specific defects for `/queues` are listed in `docs/known-issues.md` — the entries there concern the *classic* queues page (`/queues-classic`, `Queues.tsx`) and the per-queue detail/control pages, not this Pro fleet view.
