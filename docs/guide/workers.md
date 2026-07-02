---
title: Workers
---

# Workers

> Route `/workers` · source `src/pages/control/WorkersPro.tsx`

![Workers](../screenshots/workers.png)

A live registry of every worker connected to the bunqueue server. Use it to confirm your consumers are alive, see how much work each has done, and evict a stuck registration.

## What it shows

At the top, a `PageHeader` titled **Workers** with the subtitle *"Registered workers and their throughput."* and a **Live** dot that is shown while the poll is healthy (`live={!error}`) and drops off when the server stops answering.

Below it, four `StatCard`s summarizing the whole fleet:

| Stat card | Meaning | Derivation |
| --- | --- | --- |
| **Total** | Number of registered workers | `workers.length` |
| **Active** (green) | Workers currently heartbeating | count of `w.status === 'active'` |
| **Stale** (amber when non-zero, else neutral) | Workers that stopped heartbeating | `workers.length − activeWorkers` |
| **Active Jobs** (blue) | Jobs in flight across the whole fleet | sum of every `w.activeJobs` |

All four values are run through `formatNumber` (thousands separators). The cards are `compact`.

Then a table, one row per worker. Columns:

| Column | Meaning | Notes |
| --- | --- | --- |
| **Worker** | Two lines: the worker **name** (`w.name`, falls back to the literal `worker` if blank) in bold, and the full **id** (`w.id`) below in monospace | The id is the stable identifier used by the Unregister action |
| **Queues** | Comma-joined list of queues the worker consumes (`w.queues.join(', ')`) | Renders `—` when the list is empty |
| **Status** | A pill: green (`active`) or amber (`stale`) | Text is the raw `w.status` string (`active` / `stale`) |
| **Active** (right-aligned, blue) | Jobs the worker is processing right now (`w.activeJobs`) | `formatNumber` |
| **Processed** (right-aligned, muted) | Lifetime completed count (`w.processedJobs`) | `formatNumber` |
| **Failed** (right-aligned, muted) | Lifetime failed count (`w.failedJobs`) | `formatNumber` |
| **Last Seen** (right-aligned, faint) | Relative time of the last heartbeat (`w.lastSeen`) | `formatRelativeTime`, e.g. "4s ago" |
| **Actions** | Per-row trash `IconButton` → Unregister | See below |

::: info
The API returns a richer `WorkerFull` shape than the table renders. Fields like `concurrency`, `hostname`, `pid`, `registeredAt`, `currentJob`, and `uptime` are present in the response but are **not** shown on this page.
:::

## What you can do

| Action | Effect | Confirm? |
| --- | --- | --- |
| **Unregister** (row trash icon) | Removes the worker's registration from the server (`DELETE /workers/:id`) | Yes — `window.confirm("Unregister worker \"<id>\"? It can re-register on its next heartbeat.")` |
| **Retry** (offline banner) | Re-runs the fetch when the server is unreachable | No |

There are no inline create/edit forms on this page — workers are created by your own consumer processes, not from the dashboard.

**Unregister flow.** On confirm, the row's trash button is disabled (the worker id is added to a `busyIds` set) so you can't double-fire. On success a green `Unregistered <id> ✓` message appears above the table; on failure a red `Unregister failed: <message>`. Either way the list is refetched afterward, so the row reappears (as active) if the worker heartbeats again, or drops off if it doesn't.

::: warning
Unregister is **not permanent**. As the confirm text says, a live worker will re-register on its next heartbeat. This is for evicting a genuinely dead/stuck registration, not for pausing an active consumer.
:::

## States & gating

- **Loading** — a `LoadingState` labeled *"Loading workers…"* is shown only on the very first load (when there's no data and no error yet). Subsequent polls refresh in place with no flicker.
- **Empty** — when zero workers are registered, an `EmptyState` with the workers icon: *"No workers registered — Workers appear here once they connect and register with the server."*
- **Error / offline** — an `OfflineBanner` with a **Retry** button renders under the header, and the header's Live dot disappears. The last-known stat cards and table remain visible (stale data is kept).
- **Truncation** — the table renders at most `MAX_ROWS = 100` workers (`workers.slice(0, 100)`). If more are registered, an amber line appears below: *"Showing first 100 of N workers."* There is no pagination.
- **Per-row gating** — the Unregister button is disabled only while that specific worker's request is in flight (`busyIds.has(w.id)`); other rows stay clickable.

## Behind the scenes

Everything on this page talks to the **bunqueue HTTP API** through the `bq` client (not the control agent, not the legacy `api`):

- `bq.workers()` → `GET /workers`. This endpoint **wraps** its payload in `data`: `{ ok, data: { workers[], stats } }`. The page unwraps it with `r.data?.workers ?? []` so the rest of the component works on a plain array. (See `docs/api-mapping.md`.)
- `bq.unregisterWorker(id)` → `DELETE /workers/:id`. Like other `bq` mutations, `call()` throws on an HTTP-200 `{ ok: false }` response, which is what surfaces the red failure message.

Polling is driven by `usePolledData`, which:

- Fetches immediately, then re-polls on the global refresh interval from the connection store (**default 3000 ms**, adjustable in Settings, floored at 500 ms).
- Self-schedules (at most one fetch in flight at a time), **pauses while the browser tab is hidden**, and issues **zero re-renders when the returned worker list is unchanged** — so a steady fleet won't visibly "refresh" every few seconds.

## Gotchas

- **Stale ≠ removed.** A worker that stops heartbeating flips to `stale` (amber) and counts toward the Stale card, but stays in the list until you unregister it or the server drops it. The row's Last Seen keeps growing.
- **Unregister is best-effort and reversible** — a still-running worker re-registers on its next heartbeat, so a re-registering row can flicker back after your success message.
- **100-worker cap with no pagination.** Past 100 workers you only ever see the first 100 (`docs/known-issues.md`: full-list `bq` endpoints are client-side, and this page truncates rather than paginating). The stat cards, however, are computed over the **full** returned list, so Total/Active/Stale/Active Jobs stay accurate even when the table is truncated.
- **Read-mostly.** The only mutation is Unregister; there's no way to start, pause, or reconfigure a worker from here — worker lifecycle lives in your consumer code.
- Don't confuse this with the classic **`/workers-classic`** (`src/pages/Workers.tsx`), which is read-only, paginated at 20 rows, has no status pill and no Unregister action, and polls via `api.overview()` instead of `GET /workers`.
