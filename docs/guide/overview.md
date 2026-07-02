---
title: Overview
---

# Overview

> Route `/` · source `src/pages/control/OverviewPro.tsx`

![Overview](../screenshots/overview.png)

The dashboard landing page: a single-screen, real-time health check for the
connected bunqueue server. It combines a connection banner, two rows of headline
stat cards, a per-queue health grid, and a live event feed — all fed from just
two polled endpoints plus one SSE stream, so it stays cheap even with many queues.

## What it shows

The `PageHeader` reads **"Overview — Real-time system health at a glance."** with
a `live` indicator. Below it, everything is derived from one `/dashboard` payload
(`overview`) and one `/queues/summary` payload (`summary`) per poll.

### Connection banner

A full-width banner above the cards. Its color and text flip between two states
based on whether the **latest** poll failed (`degraded = !!error`):

| Element | Online (poll ok) | Degraded (poll failed) |
| --- | --- | --- |
| Dot | Green, animated ping | Amber, static |
| Title | "bunqueue server connected" | "Connection lost — showing last known data" |
| Pill (right) | "Online" (emerald) | "Stale" (amber) |
| Border/background | Emerald tint | Amber tint |

The mono subtitle line always reads `{host} · uptime {uptime} · {ram} RAM`, where:

- **host** — `localhost:6790` when the dashboard talks to the proxy (`baseUrl === '/api'`), otherwise `baseUrl` with the `http(s)://` scheme stripped.
- **uptime** — `stats.uptime` from `/dashboard`, which is in **milliseconds**; the page divides by 1000 before `formatUptime`. Shows `—` when uptime is 0/absent.
- **ram** — `memory.rss` from `/dashboard`, treated as **megabytes** (`memory.rss * 1024 * 1024` bytes) and passed through `formatBytes`.

### Row 1 — headline counters

Six `StatCard`s. Values run through `formatNumber` unless noted:

| Field | Meaning | Tone / color rule |
| --- | --- | --- |
| Completed | `stats.totalCompleted` — lifetime completed jobs | Green |
| Failed | `stats.totalFailed` — lifetime failed jobs | Red when non-zero, else default |
| Waiting | `stats.waiting` — jobs currently queued | Amber |
| Active | `stats.active` — jobs currently processing | Blue |
| Error Rate | `errorRate(totalCompleted, totalFailed)` via `formatPercent` | Red when `> 0.05` (5%), else green |
| DLQ | `stats.dlq` — dead-letter queue depth | Red when non-zero, else default |

### Row 2 — throughput, capacity, runtime

Six more `StatCard`s:

| Field | Meaning | Notes |
| --- | --- | --- |
| Push/sec | `throughput.pushPerSec` | `.toFixed(1)`, accent tone, hint "jobs/sec" |
| Pull/sec | `throughput.pullPerSec` | `.toFixed(1)`, accent tone, hint "jobs/sec" |
| Queues | `queuesTotal` (length of `/queues/summary`) | hint `{crons.total} cron active` |
| Total Pushed | `stats.totalPushed` — lifetime enqueued | — |
| API Keys | `token ? 1 : 0` | hint "token set" / "no auth". Reflects **this dashboard's** auth token only, not a server-side key count |
| Uptime | same `uptime` string as the banner | hint `{ram} RAM` |

::: info
`throughput.completePerSec` / `failPerSec` and `memory.heapUsed` / `heapTotal`
exist in the payload (see the `EMPTY` shape) but are **not** rendered on this page —
they surface on the Metrics/Usage pages instead.
:::

### Queue Health

A `SectionHeading` ("Queue Health", **View All** → `/queues`) over a grid of cards
for the **first 6** queues from `/queues/summary` (`summary.slice(0, 6)`). Each card
is a `Link` to `/queues/:name` (the classic queue-detail drill-in) and shows:

| Element | Meaning |
| --- | --- |
| Name | Queue name (mono, accent, truncated) |
| Badge | `paused` (orange) or `active` (emerald) from `q.paused` |
| `W` | waiting count (amber) |
| `A` | active count (blue) |
| `C` | completed count (emerald) |
| `F` | failed count (red) |

Each metric renders `—` when its count is `null` (the `counts` object is
nullable per the `QueueHealth` type); real numbers go through `formatNumber`.

### Recent Activity

A `SectionHeading` ("Recent Activity", **View All** → `/logs`) over a card that
lists the **last 8** events from the live SSE stream (`events.slice(0, 8)`). Each
row shows a status dot, the queue name (or `—`), the first 8 chars of the job ID
(or `—`), the capitalized status, and a relative timestamp (`formatRelativeTime`).
Dot colors: completed = emerald, failed = red, active = blue, waiting = amber,
anything else = accent.

## What you can do

This page is **read-only monitoring** — there are no mutating actions, no forms,
and no `window.confirm` gates. All interactions are navigation or a retry:

| Action | Effect |
| --- | --- |
| Click a Queue Health card | Navigate to `/queues/:name` (classic queue detail) |
| **View All** (Queue Health) | Navigate to `/queues` |
| **View All** (Recent Activity) | Navigate to `/logs` |
| **Retry** on the offline banner | Call `refetch()` to re-run the poll immediately |

## States & gating

- **Loading (first load):** while the first poll is in flight and there is no data and no error, the page renders `<LoadingState label="Loading overview…" />` (a full-page loader).
- **Loaded / degraded:** once data exists, a failed poll never blocks the UI. `error` is truthy → an `OfflineBanner` (with **Retry**) appears at the top, the connection banner flips to amber "Stale", and the page keeps rendering the **last known** numbers.
- **Never-connected / embedded server:** if there is no data at all, the page falls back to the `EMPTY` shape (all zeroes, empty queue list) so the full layout still renders instead of erroring.
- **Empty queues:** when `details.length === 0`, Queue Health shows a card reading **"No queues yet."**
- **No activity yet:** when the SSE buffer is empty, Recent Activity shows **"Waiting for live activity…"**.

::: info No job-action gating
Unlike job-centric pages, this page has no per-state action gating from
`src/lib/jobActions.ts` — it neither retries, deletes, promotes, nor edits any job.
:::

## Behind the scenes

- **Client:** the `bq` client (the shape-verified one), plus the shared activity-stream hook.
- **Poll:** `usePolledData` runs `Promise.all([bq.overview(), bq.queuesSummary()])` on the global refresh interval (`connectionStore.refreshMs`, default **3000 ms**, floored at 500 ms). It uses a recursive `setTimeout` (at most one in-flight fetch) and only re-renders when the payload actually changes.
  - `bq.overview()` → **`GET /dashboard`**
  - `bq.queuesSummary()` → **`GET /queues/summary`**
- **SSE:** `useActivityStream()` (no queue arg) subscribes to **`/events`** (`api.eventsUrl()`). It keeps a 250-event ring buffer, flushes to state on a ~150 ms timer (so a high-rate stream can't force a render per frame), and reconnects on a **2000 ms** backoff if the stream drops. `RecentActivity` is its own leaf component so live events re-render only that list, not the stat cards or queue grid.
- **Efficiency:** intentionally **two requests per poll**, not an N-queue fan-out — `/queues/summary` already carries every queue's `{waiting, active, completed, failed, delayed}` counts, so no per-queue `queueDetail` calls are needed (`known-issues.md`: "Per-poll fan-outs collapsed. OverviewPro (was 8 req/poll)").

### Response-shape gotchas (from `docs/api-mapping.md`)

- **`GET /queues/summary` is a bare array** — `[{ name, paused, counts:{…} }]` with **no `{ ok }` envelope**.
- `stats.uptime` is **milliseconds** (divided by 1000 before formatting); `memory.rss` is **megabytes** (multiplied to bytes before formatting) — mismatching these is a real historical bug (`known-issues.md`: uptime "no longer rendered ~1000× too large (ms→s)").

## Gotchas

::: warning
- **API Keys is a local flag, not a server count.** It shows `1` only when *this dashboard* has an auth token set, `0` otherwise — it never reflects how many keys the server has.
- **Queue Health caps at 6 queues.** `summary.slice(0, 6)` — use **View All** to see the rest. `queuesTotal` still counts them all.
- **Recent Activity is per-page and volatile.** It holds its own SSE subscription and buffer; it starts empty on every mount and only fills as new events arrive (no backfill of history). The fuller `/logs` view uses the same hook with its own separate buffer.
- **Degraded ≠ down.** The amber "Stale" banner means the *latest* poll failed; numbers on screen may be seconds-to-minutes old. An older doc note claimed the banner was permanently "Online" — that bug is fixed (`known-issues.md`: "OverviewPro banner reflects connection loss").
:::
