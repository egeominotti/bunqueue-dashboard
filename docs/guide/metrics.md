---
title: Metrics
---

# Metrics

> Route `/metrics` · source `src/pages/control/MetricsPro.tsx`

![Metrics](../screenshots/metrics.png)

The live telemetry page for the whole server. It samples the bunqueue HTTP API's `/dashboard` overview once per second — independently of the normal page poll — and turns it into rolling 60-second charts, so you can see at a glance whether the system is keeping up: throughput, backlog trend, error rate, latency distribution, and a per-queue breakdown.

## What it shows

The page is read-only telemetry. It draws from two independent data feeds:

- a **1-second sampler** (`useThroughputSeries(60)`) that calls `GET /dashboard` and feeds every stat card, both charts, the error-rate card, the server-overview list and the latency table;
- the **page poll** (`usePolledData`) that calls `GET /queues/summary` for the per-queue table only.

### Header

`PageHeader` renders the title **Metrics** with the description *"Real-time performance telemetry for your queues."* and a **Live** indicator wired to `live={!error}` — so the dot reflects whether the `/queues/summary` poll is healthy, not the 1s sampler.

### Four stat cards

| Field | Meaning |
| --- | --- |
| **Total Completed** | All-time completed jobs (`stats.totalCompleted`). Green tone, hint *"all time"*. Rendered with `formatCompact`, so large values are abbreviated (e.g. `5.8K`, `3.4M`) and lose exact digits. |
| **Total Failed** | All-time failed jobs (`stats.totalFailed`). Red tone, hint *"all time"*. Rendered with `formatNumber`, so it shows the exact count with `.`-grouped thousands (e.g. `3` or `1.204`). |
| **Push/sec** | Current push throughput (`throughput.pushPerSec`), accent tone, hint *"jobs/sec"*, one decimal (`.toFixed(1)`). |
| **Pull/sec** | Current pull throughput (`throughput.pullPerSec`), accent tone, hint *"jobs/sec"*, one decimal. |

### Live Throughput chart

An `AreaChart` titled **Live Throughput** (*"Real-time jobs per second (rolling 60s window)"*). Three series, each a 60-point rolling window sampled once/sec:

| Series | Color | Source |
| --- | --- | --- |
| Pushed | pink `#ec4899` (filled area) | `throughput.pushPerSec` |
| Completed | green `#34d399` (line) | `throughput.completePerSec` |
| Failed | red `#f87171` (line) | `throughput.failPerSec` |

The X axis is labelled `-60s · -45s · -30s · -15s · now`. A live legend above the chart shows each series' current value as `<n.n>/s` (`Legend` component, one decimal).

### Queue Depth chart

An `AreaChart` titled **Queue Depth** showing backlog over time, where **depth = waiting + active + delayed** (summed each second in the sampler). To the right:

- **depthNow** — the latest depth value, large and bold (`formatNumber`).
- a **trend label** computed by `depthTrend` via least-squares slope over the sampled window:
  - `draining` (slope < −0.05) → green, and the chart area turns green `#34d399`;
  - `accumulating` (slope > 0.05) → red/danger, chart area amber `#f59e0b`;
  - `steady` (in between) → faint.
  - For non-steady trends the label reads `±<slope>/s · <label>` (e.g. `+12.3/s · accumulating`); `steady` shows just the word.

::: tip Why a trend, not a gauge
The description on the card spells out the intent: *"The trend says whether you're draining or falling behind — more useful than any single gauge."* A backlog of 40k that is `draining` is fine; the same number `accumulating` is a problem.
:::

### Error Rate card

Failed as a percentage of processed. `rate = errorRate(totalCompleted, totalFailed)` = `failed / (completed + failed)` (0 when nothing processed).

| Field | Meaning |
| --- | --- |
| **error rate** | `formatPercent(rate)` (2 decimals). Turns red (`text-danger`) when `rate > 0.05` (above 5%). |
| **success rate** | `formatPercent(1 − rate)`, always green. |
| progress bar | An emerald fill over a red track, width = `(1 − rate) × 100%`. |
| footer | `<completed> completed` (compact) · `<failed> failed` (full number). |

### Server Overview card

Current server-wide counts from `stats`, one labelled row each (colored dot + value):

| Row | Source | Format |
| --- | --- | --- |
| Queued | `stats.waiting` | `formatNumber` |
| Processing | `stats.active` | `formatNumber` |
| Delayed | `stats.delayed` | `formatNumber` |
| Dead Letter | `stats.dlq` | `formatNumber` |
| Total Pushed | `stats.totalPushed` | `formatCompact` |
| Total Pulled | `stats.totalPulled` | `formatCompact` |
| Uptime | `stats.uptime` | `formatUptime(uptime / 1000)` — the payload is in **milliseconds**, divided to seconds before formatting → `3d 4h 12m` |

### Operation Latency table

**TCP round-trip per operation**, in milliseconds — these are transport-level operation latencies, *not* job wait/processing time. Rows are the fixed set `push`, `pull`, `ack`:

| Column | Source |
| --- | --- |
| Operation | the op name (capitalized) |
| Avg | `latency.averages['<op>Ms']` (note the `Ms` suffix key) |
| p50 / p95 / p99 | `latency.percentiles[<op>].p50 / .p95 / .p99` |

Cells use `fmtMs`: values under 10 keep one decimal (`3.4ms`), 10+ are rounded (`42ms`), and anything missing / non-finite renders `—`. The **p99** column is tinted `text-warning` (amber) to draw the eye to tail latency.

### Per-Queue Metrics table

Job-count breakdown per queue, from `GET /queues/summary` (one row per queue):

| Column | Source | Color |
| --- | --- | --- |
| Queue | `d.name` (monospace) | accent |
| Status | `d.paused` | amber `paused` pill / emerald `active` pill |
| Waiting | `d.counts.waiting` | amber |
| Active | `d.counts.active` | blue |
| Completed | `d.counts.completed` | green |
| Failed | `d.counts.failed` | red |

Paginated at **15 rows per page** via the shared `Pagination` control (labelled *"queues"*). Empty body shows *"No queues yet."*

## What you can do

This page has **no mutating actions** — no buttons that change server state, no forms, no `window.confirm` gates, and no per-job actions. Everything is observe-only:

| Action | Effect | Confirm? |
| --- | --- | --- |
| Watch live throughput / depth | Charts and the header **Live** dot update automatically | — |
| Read the depth trend label | Judge draining vs accumulating instead of eyeballing a single number | — |
| Page the per-queue table | `Pagination` next/prev when there are more than 15 queues | — |
| **Retry** (offline banner) | Calls `refetch()` on the `/queues/summary` poll after the server becomes unreachable | — |

::: info No job actions here
`src/lib/jobActions.ts::actionGates` governs pages that act on individual jobs (retry / promote / remove, etc.). Metrics never touches individual jobs, so none of that state→action gating applies to this page.
:::

## States & gating

- **Loading** — `LoadingState` with *"Loading metrics…"* is shown only on the very first load, while `loading && !data && !error`. Once any data (or an error) has arrived, the full layout renders instead of the spinner.
- **Offline / error** — if the `/queues/summary` poll fails, an `OfflineBanner` with a **Retry** button appears under the header and the header **Live** dot goes off (`live={!error}`). The page does **not** blank out: the throughput sampler's `EMPTY_OVERVIEW` fallback supplies zeroed `stats` / `throughput` / `latency`, so all cards, charts and the latency table still render (as zeros / `—`) rather than crashing.
- **Empty** — with a reachable server but no queues, the per-queue table shows *"No queues yet."*; charts start empty and fill in over ~60s.
- **Backgrounded tab** — both feeds pause while `document.hidden` is true: the 1s sampler skips its tick, and `usePolledData` skips its poll. Neither backfills the gap when you return.
- **Disabled/hidden controls** — none; there are no controls to disable.

## Behind the scenes

Two independent clients, both `bq` (the shape-verified client), against the bunqueue HTTP API — not the control agent:

| Call | Endpoint | Cadence |
| --- | --- | --- |
| `bq.overview()` | `GET /dashboard` | fixed **1 s** `setInterval` inside `useThroughputSeries(60)` |
| `bq.queuesSummary()` | `GET /queues/summary` | global refresh interval via `usePolledData` (default **3000 ms**, min 500 ms; from `connectionStore.refreshMs`) |

Notes on the feeds:

- The comment in the source is explicit: only `/queues/summary` is polled by the page, because the live overview (stats/throughput/latency) already comes from the 1s sampler — so `/dashboard` isn't polled twice.
- `useThroughputSeries` has an **in-flight guard**: if a `/dashboard` request takes longer than 1 s, the next tick is skipped rather than overlapping, preventing out-of-order samples. Failed samples are swallowed as transient (the chart just doesn't advance that second).
- Depth is derived client-side each tick: `waiting + active + delayed`.

Response-shape gotchas (from `docs/api-mapping.md`):

- `GET /queues/summary` returns a **bare array** — `[{ name, paused, counts: { waiting, active, completed, failed, delayed } }]` — with **no `{ ok }` envelope** at all. One round-trip covers every queue's full counts.
- `/dashboard`'s `latency` is nested per operation: `averages` as `{ pushMs, pullMs, ackMs }` and `percentiles` as `{ push: { p50, p95, p99 }, … }` — the page reads those exact keys.
- `/dashboard`'s `stats.uptime` is in **milliseconds**; the page divides by 1000 before `formatUptime`.

## Gotchas

- **Charts build up client-side.** The 60-second window starts empty every time you open the page — there's no server-side history/backfill. Leave it open a minute for the full window.
- **Hidden tab = frozen charts.** Both pollers skip while the tab is backgrounded and do **not** backfill; the series simply resume from where they left off, so a gap in real time compresses into adjacent samples.
- **Total Completed is abbreviated.** It uses `formatCompact` (`5.8K`, `3.4M`), so it loses exact digits — Total Failed uses `formatNumber` and stays exact. Read the Error Rate card's footer for the paired precise counts.
- **Latency is transport, not job time.** The Operation Latency table measures TCP round-trip per `push`/`pull`/`ack` op, not how long jobs wait or run.
- **Live dot ≠ chart liveness.** `live={!error}` tracks the `/queues/summary` poll. If that poll is fine but the 1s `/dashboard` sampler is failing transiently, the charts can stall while the dot still shows Live.
- **Fixes already applied here** (see `docs/known-issues.md`): the latency table reads the real nested per-operation keys (the legacy always-`0ms` percentile bug is gone), and uptime is no longer rendered ~1000× too large (ms→s). The classic `/metrics-classic` page still shows the raw-payload quirks. The MetricsPro/`/dashboard` duplicate-poll was collapsed so the page issues one `/dashboard` sample per second plus one `/queues/summary` per refresh interval.
