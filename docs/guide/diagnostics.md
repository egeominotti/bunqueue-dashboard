---
title: Diagnostics
---

# Diagnostics

> Route `/diagnostics` · source `src/pages/control/Diagnostics.tsx`

![Diagnostics](../screenshots/diagnostics.png)

A single-glance health page for the bunqueue **server itself**. It continuously polls three read-only endpoints — `/health`, `/storage`, and `/stats` — and surfaces "is the server up, how long has it been running, is the disk full, is anything connected, and how much memory is it using?" Use it as your first stop whenever the dashboard feels wrong.

## What it shows

The page is built from a four-card stat row across the top, two side-by-side cards (**Connectivity**, **Memory**), and an optional **Lifetime totals** card at the bottom. Every value is derived from the three polled endpoints — the page holds no state of its own except the last ping result.

### Top stat row

| Field | Meaning |
| --- | --- |
| **Status** | The server's health flag. Shows `health.status` verbatim if present; otherwise `healthy` when `health.ok` is truthy, `degraded` when it is not. Tinted **green** when `ok`, **red** otherwise. From `GET /health`. |
| **Version** | The bunqueue server version, rendered as `v{version}` (e.g. `v2.8.26`), or `—` when `/health` reports no version. From `GET /health`. |
| **Uptime** | How long the server process has been running, passed through `formatUptime(health.uptime)` (e.g. `52m`). `uptime` is expected in **seconds** here. From `GET /health`. |
| **Disk** | `Full` (red) when `storage.data.diskFull` is truthy, otherwise `Healthy` (green). From `GET /storage`. When `/storage` fails to load, `disk` is null → renders `Healthy`. |

### Connectivity card

A key/value list (`Row` components) fed from `health.connections` and `storage.data`:

| Field | Meaning |
| --- | --- |
| **WebSocket clients** | `health.connections.ws`, or `0` if absent — number of live WebSocket clients attached to the server. |
| **SSE clients** | `health.connections.sse`, or `0` if absent — live Server-Sent-Events subscribers. Note the dashboard's own activity stream counts as one, so `1` is normal while the dashboard is open. |
| **Storage error** | The last storage error string from `storage.data.error`, or the literal `none` when there is no error (or `/storage` didn't load). |

::: info
The `health.connections.tcp` field is read into the component's type but is **not** rendered — only `ws` and `sse` are shown in Connectivity.
:::

### Memory card

Three mini-stats from `health.memory`, each value **multiplied by `1024 * 1024`** before being passed to `formatBytes` — i.e. the server reports these numbers in **megabytes**, and the page converts them to bytes for human-readable formatting. Missing values default to `0`.

| Field | Meaning |
| --- | --- |
| **Heap used** | `health.memory.heapUsed` (MB) → formatted (e.g. `75.0 MB`). |
| **Heap total** | `health.memory.heapTotal` (MB) → formatted (e.g. `96.0 MB`). |
| **RSS** | `health.memory.rss` (MB) → resident set size (e.g. `435.0 MB`). |

### Lifetime totals card

Only rendered when `/stats` returned a `stats` object (`d.stats?.stats`). Four cumulative counters since the server started tracking, each via `formatNumber`:

| Field | Meaning |
| --- | --- |
| **Pushed** | `stats.totalPushed` — jobs enqueued. |
| **Pulled** | `stats.totalPulled` — jobs handed to workers. |
| **Completed** | `stats.totalCompleted` — jobs acked as done. |
| **Failed** | `stats.totalFailed` — jobs that failed. |

## What you can do

| Action | Effect | Confirm? |
| --- | --- | --- |
| **Ping** (button in the Connectivity card header) | Fires `GET /ping` and measures wall-clock round-trip time with `performance.now()`. While in flight the button label shows `Ping · …`; on success it shows the latency in ms (`Ping · 34 ms`); on failure `Ping · unreachable`. The result stays on the button until you ping again. | No |
| **Retry** (on the offline banner) | Calls `refetch()` to immediately re-poll all three endpoints. Only visible when the last poll errored. | No |

There are **no** forms, filters, or mutating controls on this page — it is entirely read-only plus the manual ping. Nothing here changes server state.

::: tip
The ping latency is measured **from your browser**, so it includes any dev-proxy hop (the `/api` → `:6790` proxy) or network path — it is not the server's internal processing time.
:::

## States & gating

This is not a job-action page, so there is no `jobActions.ts` state gating. The relevant states are load/error/degrade:

- **Loading** — on first load with no data and no error, the whole page is replaced by `<LoadingState label="Loading diagnostics…" />`.
- **Populated** — once any poll resolves, cards render. Subsequent polls refresh in place without a spinner.
- **Offline / error** — if the poll's `bq.health()` throws, `error` is set: an `<OfflineBanner onRetry={refetch} />` appears under the header and the header's **Live** dot turns off (`live={!error}`). The page still renders using the `EMPTY` fallback (`{ health: {}, storage: null, stats: null }`) so you see zeroed cards instead of a blank error screen.
- **Partial degrade** — `bq.storage()` and `bq.stats()` are each wrapped in `.catch(() => null)`, so a failure of either does **not** flip the page into the error state. `/storage` failing → Disk shows `Healthy`, Storage error shows `none`. `/stats` failing → the entire **Lifetime totals** card is hidden.
- **Degraded server** — a real disk-full (or otherwise unhealthy) server responds to `/health` with `{ ok: false }` at **HTTP 200**, which is *not* treated as an error. Status flips to `degraded`/red and (if `/storage` also reports it) Disk flips to `Full`/red, but the page stays live and populated.

## Behind the scenes

All data goes through the **`bq`** client (never the classic `api`), because `bq.storage()` has the correct wrapped `{ ok, data }` type that the classic client gets wrong.

| Call | Endpoint | Notes |
| --- | --- | --- |
| `bq.health()` | `GET /health` | Flat `{ ok, status, version, uptime, queues, connections, memory }`. Called with **`strict:false`** — `ok` here is a *health* flag, not a request-success flag, so `ok:false` (disk-full at HTTP 200) is data, not a thrown error. This is the only call that can throw → set the page's `error`. |
| `bq.storage()` | `GET /storage` | Wrapped: `{ ok, data: { diskFull, error, since } }`. There is **no** `path` field. Read as `d.storage.data`. `.catch(() => null)`. |
| `bq.stats()` | `GET /stats` | `{ ok, stats: { totalPushed, totalPulled, totalCompleted, totalFailed, … } }`. Read as `d.stats.stats`. `.catch(() => null)`. |
| `bq.ping()` | `GET /ping` | Wrapped: `{ ok, data: { pong, time } }`. Fired only on the manual **Ping** button; its payload is discarded — only the round-trip time is used. |

Polling is driven by `usePolledData`, which fetches once immediately and then re-runs on a recursive `setTimeout` (at most one in-flight fetch) at the **global refresh interval** from the connection store — default **3000 ms**, adjustable in Settings (floored at 500 ms). The three read endpoints are fetched together via `Promise.all` on every tick; **Ping is not** on the poll loop.

## Gotchas

- **Memory unit assumption.** The page multiplies `heapUsed`/`heapTotal`/`rss` by `1024²` before formatting, i.e. it assumes `/health` reports memory in **MB**. If a server build ever reports raw bytes, these cards would read ~1,000,000× too large. Uptime is likewise assumed to be in **seconds**.
- **`tcp` connections are invisible** — only `ws` and `sse` are shown, even though `connections.tcp` exists in the payload.
- **A dashboard SSE of `1` is not a leak** — the dashboard's own activity stream registers as an SSE client, so expect at least `1` while the dashboard tab is open.
- **Ping latency includes the proxy** — in dev it traverses the Vite `/api` proxy to `:6790`; treat it as end-to-end reachability, not server CPU time.
- **Silent partial data** — because `/storage` and `/stats` failures are swallowed, a broken `/storage` masquerades as `Disk: Healthy` / `Storage error: none`, and a broken `/stats` simply removes the totals card with no error. Only a failing `/health` produces the offline banner.
- Per `docs/known-issues.md`, `live={!error}` on Diagnostics reflects only the `/health` poll — the header's Live dot stays green even if `/storage`/`/stats` are failing. The classic `api.ts` `/storage` shape bug does not affect this page (it uses `bq`).
