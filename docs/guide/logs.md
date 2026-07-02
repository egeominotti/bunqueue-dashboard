---
title: Logs
---

# Logs

> Route `/logs` · source `src/pages/control/LogsPro.tsx`

![Logs](../screenshots/logs.png)

A live, filterable feed of every job event the bunqueue server emits over its
Server-Sent-Events (SSE) stream. The page header is titled **Activity Logs**
("Real-time job activity across all queues") and is driven entirely by the
`useActivityStream` hook — a bounded in-memory ring buffer of recent events plus
cumulative counters and a rolling throughput. Nothing here is server-side
history; it is a session-local live view.

## What it shows

The header carries a **Live** indicator that reflects the real SSE connection
state (`connected` from the stream hook), followed by six compact stat cards, a
filter row, and a paginated event table (10 rows per page).

### Stat cards

All six values come from `useActivityStream`'s counters/throughput and are
formatted with `formatNumber`. Counters accumulate from the moment you opened
the page (or last changed the queue filter / connection) — they are **not**
server totals.

| Field | Meaning |
| --- | --- |
| **Total Events** | `counters.total` — every `job:*` frame received since the subscription started. |
| **Completed** | `counters.completed` — events whose status resolved to `completed`. Card tone is always green. |
| **Failed** | `counters.failed` — events whose status resolved to `failed`. Tone is red when non-zero, neutral (`default`) when zero. |
| **Waiting** | `counters.waiting` — events mapped to `waiting` (event suffixes `pushed`/`added`). Amber tone. |
| **Active** | `counters.active` — events mapped to `active` (suffixes `pulled`/`progress`, plus `job:active`). Blue tone. |
| **Throughput** | `throughput.toFixed(1)` with a `/s` suffix — a **rolling 5-second rate** (count of event timestamps in the last 5 s ÷ 5), recomputed every second. Accent tone. |

::: info Status derivation
The status shown per row and counted per card is derived from the event name by
`statusFromEvent`: the suffix after the colon is used, with `pushed`/`added` →
`waiting` and `pulled`/`progress` → `active`. Everything else (e.g.
`completed`, `failed`, `active`) passes through as-is.
:::

### Event table

Five columns, rendered from the filtered + paginated slice of the buffer:

| Column | Meaning |
| --- | --- |
| **Status** | A `StatusBadge` colored by the derived status (`e.status`). |
| **Event** | The raw event type in monospace, e.g. `job:completed`, `job:pushed`, `job:active`, `job:progress`, `job:failed` (`e.event`). |
| **Queue** | The source queue name in a monospace chip, or `—` when the payload has no queue (`e.queue`). |
| **Timestamp** | Relative time via `formatRelativeTime(e.timestamp)`; the payload's `timestamp` is used, falling back to receive time. |
| **ID** | The job ID in monospace, or `—` when absent (`e.jobId`). |

Note there is **no job-name column**: SSE job payloads carry no `name`
server-side, so the event type stands in for it.

## What you can do

This is a read-only observation page — there are no mutating actions, no
`window.confirm` gates, and no inline forms that change server state. The
controls only shape what the live buffer displays.

| Action | Effect | Confirm? |
| --- | --- | --- |
| **Queue dropdown** (`All Queues` + one option per queue) | Scopes the subscription. `All Queues` streams `/events`; picking a queue **reopens the SSE subscription** against that queue and resets the buffer/counters. | No |
| **Status segmented control** (`all` / `waiting` / `active` / `completed` / `failed`) | Client-side filter on `e.status`; `all` shows everything. | No |
| **Search box** (`Search by job ID or queue…`) | Case-insensitive substring match on `jobId` **or** `queue`. Empty = no filtering. | No |
| **Pagination** (Previous / Next) | Pages the filtered results 10 at a time over the in-memory buffer. | No |

::: tip Filters reset the page
Changing the queue, status, or search value snaps pagination back to page 0 (a
`useEffect` resets `page` on any filter change), so you always land on the newest
matching events.
:::

## States & gating

There are no job-action state gates on this page (it never calls
`src/lib/jobActions.ts`). The relevant states are connection/empty conditions,
all surfaced through the single table body:

- **Offline / fetch error** — only the *dropdown options* are polled (via `bq.queues()`); if that poll errors, an `OfflineBanner` renders under the header with a **Retry** button (`refetch`). The live event stream is independent of this.
- **Connecting** — when the stream is not `connected` and no events have buffered yet, the empty row reads **"Connecting to the event stream…"**.
- **Idle but connected** — when `connected` is true but no `job:*` events have arrived (`events.length === 0`), it reads **"Waiting for activity…"**. Handshake / periodic `stats`/`health` frames flip `connected` true without producing rows.
- **No matches** — when there are buffered events but none pass the current filters, it reads **"No events match the current filters."**
- **Auto-reconnect** — a dropped stream (clean end or network error) clears the Live flag and retries after a **2-second backoff**; the view recovers on its own.

## Behind the scenes

Two independent data paths:

- **Live stream (primary):** `useActivityStream(queue)` opens a fetch-based SSE reader against `api.eventsUrl(queue)` — `GET /events` for *All Queues*, or `GET /events/queues/:q` when scoped. This uses the `api` client's URL/auth (not `EventSource`, so the bearer token can be sent). The first frame is a handshake (`data: {"connected":true,…}`, default event name `message`); only frames whose event starts with `job:` become rows. Incoming frames are buffered and flushed to React state on a ~150 ms timer (≤ ~7 updates/s), and the buffer is capped at **250 events** (`MAX_EVENTS`).
- **Queue dropdown options (secondary):** `bq.queues()` → `GET /dashboard/queues`, polled every **30 s** (`intervalMs: 30000`) so it never rides the live SSE cadence. Its `queues[]` fills the dropdown; nothing else on the page depends on it.

::: warning Response-shape gotcha
The SSE handshake frame has **no `event:` line**, so it parses under the SSE-spec
default event name `message` rather than a literal `connected` event — the hook
uses `frameIndicatesConnected` to still mark the stream live. Job payloads carry
`queue`/`jobId`/`timestamp` (plus optional `error`/`progress`) but **never a job
name** (see `docs/api-mapping.md` → Live stream).
:::

## Gotchas

- **Session-local, not history.** The buffer holds only the most recent 250 events and counters start from when you opened the page. They reset on reload, on navigation away, and whenever you change the queue filter or connection target — these are not server-side totals.
- **No job names.** Because SSE events carry no `name`, the table shows the event type + job ID. The classic `/logs-classic` page's "Job Name" column is permanently "unknown" for the same reason (`docs/known-issues.md`); the Pro page here works around it by showing the event type instead.
- **Filtering/search only reach what's buffered.** Older events that scrolled past the 250-event cap can't be searched or paged to — there is no fetch-back of history.
- **A `queue` change reopens the stream.** Switching from *All Queues* to a specific queue (or back) tears down and re-subscribes, clearing the buffer and zeroing the counters, so live rates briefly reset.
- **Ordering under bursts is stable.** A past StrictMode bug that misordered high-rate bursts in `useActivityStream`'s flush was fixed (`docs/known-issues.md`); rows now render newest-first as expected.
