---
title: Usage
---

# Usage

> Route `/usage` · source `src/pages/control/UsagePro.tsx`

![Usage](../screenshots/usage.png)

A single-screen, read-only summary of **cumulative resource usage** on the connected
bunqueue server: lifetime job totals, live queue counts, error rate, process memory,
uptime, and an honest disk-health verdict. Everything auto-refreshes on the dashboard's
global poll — the "Live" dot next to the title signals that.

## What it shows

The page header reads **Usage — "Cumulative resource usage on the connected server."**
with a `live` indicator (`PageHeader … live`). Below it are six stat cards, then two
detail cards (Runtime and Storage).

### Top stat cards (six)

Rendered in a responsive grid (2 columns on mobile → 6 on `xl`). Each is a `StatCard`
with a colour `tone`.

| Field (label) | Meaning | Source / derivation | Colour behaviour |
| --- | --- | --- | --- |
| **Completed** | Lifetime count of jobs that finished successfully | `stats.totalCompleted` | Always green (`tone="green"`) |
| **Failed** | Lifetime count of jobs that failed | `stats.totalFailed` | Red when non-zero, otherwise neutral (`tone={stats.totalFailed ? 'red' : 'default'}`) |
| **Waiting** | Jobs currently queued and waiting to run | `stats.waiting` | Amber (`tone="amber"`) |
| **Active** | Jobs currently being processed right now | `stats.active` | Blue (`tone="blue"`) |
| **Error Rate** | Share of terminal jobs that failed, as a percentage | `errorRate(totalCompleted, totalFailed)` = `failed ÷ (completed + failed)`, formatted with `formatPercent` (2 decimals) | Red above 5% (`rate > 0.05`), otherwise green |
| **Uptime** | How long the server process has been running | `stats.uptime` (milliseconds) ÷ 1000 → `formatUptime` (days/hours/minutes) | Neutral; shows `—` when uptime is 0/absent |

::: info Number formatting
Counts go through `formatNumber` (locale `Intl.NumberFormat`), so large values use the
locale thousands separator — e.g. `5825` renders as `5.825` in the reference/demo locale.
Non-finite or null values fall back to `0`. `Error Rate` is a fraction ×100 with two
decimals; `0` completed **and** `0` failed yields `0%` (division guarded in `errorRate`).
:::

### Runtime card

A definition list (`<dl>`) of five rows (`Row` label/value pairs):

| Row | Meaning | Source / derivation |
| --- | --- | --- |
| **Jobs pushed** | Lifetime jobs enqueued into the server | `formatNumber(stats.totalPushed)` |
| **Jobs pulled** | Lifetime jobs dequeued by workers | `formatNumber(stats.totalPulled)` |
| **Heap used** | V8 heap in use by the process | `formatBytes(memory.heapUsed * 1024 * 1024)` — `/dashboard` reports memory in **MB**, so it is converted to bytes before formatting |
| **RSS** | Resident set size (total process memory) | `formatBytes(memory.rss * 1024 * 1024)` — same MB→bytes conversion |
| **Cron jobs** | Number of registered cron schedules | `String(crons.total)` (raw count, not run through `formatNumber`) |

### Storage card

A single health panel driven by the real `/storage` disk-health flag (`StorageStatusFlat`):

- **Healthy** (green panel): shown when `storage.diskFull` is falsy. Reads **"Healthy"**
  with subtext **"Disk writes are being accepted."**
- **Disk full — writes suspended** (red panel): shown when `storage.diskFull` is truthy.
  Reads **"Disk full — writes suspended"**, and additionally shows:
  - `storage.error` as muted subtext, when present;
  - **"since &lt;relative time&gt;"** (`formatRelativeTime(storage.since)`) when
    `storage.since` is not null — how long ago writes were suspended.

## What you can do

This page is **read-only** — it has no mutating actions, forms, or `confirm()` gates.

| Action | Effect | Confirm? |
| --- | --- | --- |
| Watch totals live | Numbers tick up automatically as workers run; no manual refresh needed | — |
| Spot trouble at a glance | A red **Failed** / **Error Rate** card, or the red **Storage** panel, is your cue to head to DLQ Control or the server host | — |
| **Retry** (offline banner only) | When the server is unreachable an `OfflineBanner` appears; its Retry button calls `refetch()` to re-poll | No |

## States & gating

- **Loading:** on the very first fetch (no data, no error yet) the page renders a full-page
  `LoadingState` with the label **"Loading usage…"** (`loading && !data && !error`).
- **Offline / error:** if either poll throws, an `OfflineBanner` is rendered at the top
  (with a **Retry** button wired to `refetch`), **but the full layout still renders** —
  the page falls back to a zeroed `EMPTY` shape (`data ?? EMPTY`) so cards show `0`,
  Uptime shows `—`, and Storage shows the green "Healthy" panel rather than blocking the
  whole page. This is intentional so an embedded/down server doesn't erase the layout.
- **Empty:** there is no distinct empty state — a fresh server simply shows zeros.
- No controls are ever disabled or hidden; there are no job actions here, so
  `src/lib/jobActions.ts` state→action gating does not apply to this page.

## Behind the scenes

The page uses the **`bq`** client (not `api`), via `usePolledData`, which fires two
requests in parallel on each poll:

- `bq.overview()` → **`GET /dashboard`** — returns the flat `OverviewResponse`
  (`{ ok, stats, memory, crons, … }`, no `data` wrapper). The page reads
  `stats`, `memory` (MB), and `crons.total` from it.
- `bq.storage()` → **`GET /storage`** — returns **`{ ok, data: { diskFull, error, since } }`**;
  the payload is wrapped in `data`, so the page unwraps `storage.data ?? {}`.

**Polling cadence:** `usePolledData` uses the global refresh interval from
`connectionStore` (`refreshMs`, default **3000 ms**, configurable in Settings, floored at
500 ms). There is no SSE stream on this page — it is pure polling. The hook does
change-detection, so a steady poll with unchanged data issues no re-render.

::: warning Response-shape gotcha
Per `docs/api-mapping.md`, `GET /storage` is **wrapped in `data`** and has **no `path`
field** — only `diskFull`, `error`, `since`. The classic `lib/api.ts` `storage()` reads
`data.status.diskFull`/`.path` (neither exists) and always renders "Healthy", masking a
real disk-full condition. `bq.ts`'s `storage()` used here has the correct flat shape.
Also note `stats.uptime` from `/dashboard` is in **milliseconds** — this page divides by
1000 before `formatUptime` (seconds-based); skipping that is the classic page's ~1000×
uptime bug.
:::

## Gotchas

- **Read-only by design.** No buttons mutate state; to act on failures go to DLQ Control,
  Queue Control, or the server host.
- **Memory units.** `heapUsed`/`rss` from `/dashboard` are **megabytes**; the page
  converts MB→bytes (`× 1024 × 1024`) before `formatBytes`. If the server ever changed
  those units, this figure would be off by ~1,048,576×.
- **Uptime shows `—`** when `stats.uptime` is 0 or missing (e.g. server just started or a
  zeroed offline fallback), not `0m`.
- **Cron count** is the raw number of registered schedules (`crons.total`), rendered
  without thousands grouping — unlike the other counts.
- **This Pro page supersedes the classic `/usage-classic`** (`src/pages/Usage.tsx`), which
  renders uptime ~1000× too large and always shows storage as "Healthy" because it reads
  the wrong `/storage` shape (see `docs/known-issues.md`). `/usage` fixes both and adds the
  Error Rate card.
- **Latency, throughput and full worker/cron lists** from `/dashboard` are **not** shown
  here — only the fields listed above. For those, use Metrics and Workers.
