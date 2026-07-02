# Pages

Every route registered in `src/App.tsx`, what it renders, which API client it
uses, and what it actually does. Verified against the current source — where a
route's label in the sidebar doesn't match the page family you'd expect (e.g.
`/jobs` does **not** render `Jobs`), that's called out explicitly below.

## How to read this page

Two page families coexist by design (see [architecture.md](architecture.md)):

- **Pro** (`src/pages/control/*`) — the corrected, complete-control surface.
  Uses `lib/bq.ts`. This is where new work happens.
- **Classic** (`src/pages/*`, first-gen) — the original read-mostly view pages.
  Uses `lib/api.ts`. Kept intact; not actively extended.

For seven routes, the **sidebar entry and the Pro page share the "plain" path**
(`/jobs`, `/dlq`, `/cron`, `/metrics`, `/workers`, `/usage`, `/s3`) and the
classic page moved to a `-classic` suffix. For everything else the classic page
still owns the plain path because no Pro replacement was built for it
(`/queues/:name`, `/settings`). Don't assume "no `-classic` suffix" means
"no classic page exists" — check the table.

## Route table (from `src/App.tsx`)

| Path | Component | Family | Client |
| --- | --- | --- | --- |
| `/` | `control/OverviewPro` | Pro | `bq` |
| `/overview-classic` | `Overview` | Classic | `api` |
| `/queues` | `Queues` | Classic (no Pro version) | `api` |
| `/queues/:name` | `QueueDetail` | Classic (no Pro version) | `api` |
| `/jobs` | `control/JobsPro` | **Pro** | `bq` |
| `/jobs-classic` | `Jobs` | Classic | `api` |
| `/dlq` | `control/DlqPro` | **Pro** | `bq` |
| `/dlq-classic` | `Dlq` | Classic | `api` |
| `/cron` | `control/CronManager` | **Pro** (same page as `/cron-manager`) | `bq` |
| `/cron-classic` | `Cron` | Classic | `api` |
| `/metrics` | `control/MetricsPro` | **Pro** | `bq` |
| `/metrics-classic` | `Metrics` | Classic | `api` |
| `/workers` | `control/WorkersPro` | **Pro** | `bq` |
| `/workers-classic` | `Workers` | Classic | `api` |
| `/logs` | `control/LogsPro` | Pro (list) + `api` (SSE URL) — mixed, see below | `bq` + `api` |
| `/logs-classic` | `Logs` | Classic | `api` |
| `/server` | `control/ServerControl` | Pro | `bq` (+ control agent) |
| `/add-job` | `control/AddJob` | Pro | `bq` |
| `/job` | `control/JobInspector` | Pro | `bq` |
| `/queue-control` | `control/QueueControl` | Pro | `bq` |
| `/cron-manager` | `control/CronManager` | Pro | `bq` |
| `/dlq-control` | `control/DlqControl` | Pro | `bq` |
| `/webhooks` | `control/Webhooks` | Pro | `bq` |
| `/diagnostics` | `control/Diagnostics` | Pro | `bq` |
| `/database` | `control/Database` | Pro — read-only SQLite inspector (tables, schema/indexes/DDL, sortable data grid, query runner with history/EXPLAIN/CSV/JSON export) via the control agent's `/db/*` endpoints | `bq.db` (agent) |
| `/usage` | `control/UsagePro` | **Pro** | `bq` |
| `/usage-classic` | `Usage` | Classic | `api` |
| `/s3` | `control/S3BackupPro` | **Pro** | `bq` + `s3Store` |
| `/s3-classic` | `S3Backup` | Classic | `api` |
| `/settings` | `Settings` | Classic (no Pro version — the only settings page) | `api`, `connectionStore`, `themeStore` |
| `*` | `NotFound` | — | — |

**Not routed at all:** `src/pages/Alerts.tsx` and its store
(`components/dashboard/stores/alertsStore.ts`) are fully built (channels,
threshold rules, enable/disable, local persistence) but there is **no
`/alerts` route in `App.tsx` and no nav item in `Sidebar.tsx`**. The page is
unreachable from the running app; only found by reading the source. If you
want it live, add a route + nav entry (see
[development.md](development.md#adding-a-page-additive)).

## Sidebar → page mapping

`src/components/layout/Sidebar.tsx` groups nav items into four sections. Some
entries point at Pro pages, some at classic pages — there's no visual
distinction in the sidebar itself:

- **Queues** — Queues (classic) · Jobs (**Pro**: JobsPro) · Dead Letter Queue
  (**Pro**: DlqPro) · Cron Jobs (**Pro**: CronManager — same page as
  `/cron-manager`; classic `Cron` moved to `/cron-classic`).
- **Monitoring** — Metrics (**Pro**: MetricsPro) · Workers (**Pro**:
  WorkersPro) · Logs (**Pro**: LogsPro).
- **Control** — Server · Add Job · Job Inspector · Queue Control · Cron
  Manager · DLQ Control · Webhooks · Diagnostics — all Pro pages, all `bq`.
- **Management** — Usage (**Pro**: UsagePro) · S3 Backup (**Pro**:
  S3BackupPro) · Settings (classic).

So there are effectively **three different DLQ pages** (`DlqPro` at `/dlq`,
`DlqControl` at `/dlq-control`, `Dlq` at `/dlq-classic`) and **three cron
routes but only two cron pages** (`CronManager` — create + read + delete —
serves both `/cron` and `/cron-manager`; the classic read-+-delete `Cron`
lives at `/cron-classic`). This is intentional per the additive rule, not an
oversight.

## Home & Control (Pro — `bq`)

| Route | Page | Behaviour |
| --- | --- | --- |
| `/` | `OverviewPro` | Connection banner (host · uptime · RAM — **static "Online"**, does not react to poll errors after first load, see [known-issues.md](known-issues.md)), two rows of stat cards, a Queue Health grid (first 6 queues, W/A/C/F), and a live Recent Activity feed from `useActivityStream()`. |
| `/server` | `ServerControl` | Start/Stop/Restart via the control agent; storage row (SQLite main/WAL/total-on-disk/last-modified from `status.db`); **always-editable** config form with a "Save & restart" shortcut and a "restart to apply" hint when the live config differs from the edited one; colour-coded live process-log tail (`stdout`/`stderr`/`sys`). |
| `/add-job` | `AddJob` | Enqueue with full options (priority/delay/maxAttempts/backoff/timeout/jobId/removeOnComplete/removeOnFail/durable/lifo), single or bulk via a `Count` field. **Gotcha:** bulk with a `Custom job ID` set sends the *same* jobId to every element — the server dedupes to one real job but the UI reports "Created N" (see known-issues.md). |
| `/job` | `JobInspector` | Look up a job by ID (deep-linkable via `?id=`, auto-looks-up on load/id-change). Shows: header with copyable job ID + custom ID, Kv overview (priority/attempts/progress/timestamps/duration), Data, Result (fetched separately via `GET /jobs/:id/result` — the job object itself never carries a populated `result`), Error (last `timeline` entry with `state:'failed'`, plus the full `stacktrace` array, uncapped), Timeline (every recorded state transition: enqueued → started → finished/retry, from `job.timeline`), Backoff schedule (computed client-side preview of the next attempts' delays, mirroring the server's `calculateBackoff`). Actions are gated by the job's *actual* current state via `lib/jobActions.ts::actionGates` — e.g. Cancel only shows for a queue-resident job, Retry (move-to-wait) only for an active job, Retry-from-DLQ only for a failed/DLQ'd job, Requeue only for a completed job — so a button is never offered for an action the server would reject. |
| `/queue-control` | `QueueControl` | Per-queue counts; Lifecycle card (pause/resume/drain/retry-completed/promote-delayed/clean); Limits cards (rate-limit, concurrency); Stall-detection form; DLQ-policy form. **Gotcha:** the Stall/DLQ-policy forms seed local state once from `config` and don't resync when you switch queues — see known-issues.md. |
| `/cron-manager` | `CronManager` | Create a schedule (cron expression *or* interval-in-ms, mutually exclusive via a segmented control) and list/delete existing ones. |
| `/dlq-control` | `DlqControl` | Single-queue DLQ view: entries table (job id, reason, error, attempts, entered), Retry-all / Retry-one / Purge, with confirmation on Purge. |
| `/dlq` | `DlqPro` | Cross-queue DLQ dashboard: total-in-DLQ / top-reason / pending-retry / distinct-reason-count cards, a clickable per-queue DLQ-count grid, then a filtered (reason + search) + sortable entries table for the selected queue, with Retry-all/Purge-all and per-row Retry. |
| `/webhooks` | `Webhooks` | Create (URL, optional queue scope, optional HMAC secret, event checkboxes from `WEBHOOK_EVENTS`), list with success/failure counts and last-triggered, enable/disable toggle, delete (confirmed). |
| `/diagnostics` | `Diagnostics` | Health/version/uptime/disk cards, a manual Ping button (round-trip ms), WS/SSE client counts, storage error, memory (heap/RSS), lifetime totals. |

## Queues / Jobs / DLQ / Metrics / Logs / S3 (Pro — `bq`)

| Route | Page | Behaviour |
| --- | --- | --- |
| `/jobs` | `JobsPro` | Cross-queue job explorer: queue + status filters, client-side ID/queue text search, stat cards, and a table with **checkbox multi-select**. Row and bulk actions are state-gated the same way as `JobInspector` (shared `actionGates`): Promote/Retry/Requeue/Cancel icons only appear where the server would actually accept them. Bulk buttons only render if at least one selected row is eligible; a bulk action is attempted on every selected row via `Promise.allSettled` and reports "`N` succeeded, `M` not eligible / failed" rather than a blanket success. |
| `/metrics` | `MetricsPro` | Live throughput area chart (rolling 60s, sampled independently of the page poll by `useThroughputSeries`), error/success-rate gauge, server-overview Kv list, per-queue counts table. **Gotcha:** the "AVG/P50/P95/P99" strip above the chart reads `latency.percentiles.{avg,p50,p95,p99}`, but per the server these percentiles are keyed by **operation** (`push`/`pull`/`ack`), not by those names — the labels currently read as `0ms` always. See known-issues.md; this is one of the two A6 fix targets. |
| `/logs` | `LogsPro` | Paginated (10/page), filterable (queue/status/search) view over the **same live SSE stream** `useActivityStream` also drives on `OverviewPro`'s Recent Activity — i.e. this is a fuller UI over the identical ring buffer, not a separate data source. |
| `/workers` | `WorkersPro` | Registered-workers table over `bq.workers()` (`{ ok, data: { workers } }`), with active/stale status and a confirmed per-row Unregister (`bq.unregisterWorker`). Caps the table at 100 rows with a truncation hint. |
| `/usage` | `UsagePro` | Cumulative totals, error rate, runtime, and an honest Storage health card from `bq.storage()` (`{ ok, data: { diskFull, error, since } }`) — red "Disk full — writes suspended" when `diskFull`, instead of the classic page's always-"Healthy" row. Renders uptime correctly (`stats.uptime` is ms). |
| `/s3` | `S3BackupPro` | Local-only (`s3Store`, `localStorage`) form to assemble S3-compatible backup settings (endpoint/region/bucket/keys/schedule/prefix) — bunqueue OSS actually reads these from **server environment variables**; this page cannot push them to the server. "Test Connection" just calls `bq.storage()` and checks `diskFull`. "Backup Now" is permanently disabled (no server trigger endpoint exists). |

## First-gen view pages (Classic — `api`)

These predate the Pro pages and are kept intact per the additive rule; several
have no Pro equivalent and are the *only* way to reach that functionality
(Queues list+drill-in, Workers, Usage, Settings).

| Route | Page | Behaviour |
| --- | --- | --- |
| `/overview-classic` | `Overview` | Stat cards + throughput + resources + a compact workers/crons summary. Single `api.overview()` poll. |
| `/queues` | `Queues` | Full queue list with client-side name search and aggregate totals; click a row to open `QueueDetail`. **No Pro replacement exists for this list** — `QueueControl` operates on one queue at a time, chosen from a `<select>`, not a browsable list. |
| `/queues/:name` | `QueueDetail` | Single-queue drill-in: pause/resume/drain/obliterate (all confirmed), counts, a 12-row recent-jobs table, and embeds `pages/queue/QueueConfig.tsx` (rate-limit + concurrency cards, its own local optimistic-save state). |
| `/jobs-classic` | `Jobs` | Same shape as `JobsPro` minus multi-select/bulk actions; single per-row Cancel. |
| `/dlq-classic` | `Dlq` | Single-queue DLQ table (reason/attempts/failed-at) + Retry-all/Purge. Reads the **flat, uncorrected** `DlqEntry` type from `lib/types.ts` (top-level `id`/`name`/`jobId`) — see known-issues.md for why this renders wrong for real entries. |
| `/cron-classic` | `Cron` | List + delete only (no create form — use `/cron` / `/cron-manager` for that). |
| `/metrics-classic` | `Metrics` | Kv dumps of `latency.percentiles` / `latency.averages` / in-memory `collections`, plus totals and memory. Same percentile-key mismatch as `MetricsPro` (worse: renders `[object Object]ms` — see known-issues.md), but a good place to see the *raw* `/dashboard` payload shape since it dumps whatever keys the server returns. |
| `/workers-classic` | `Workers` | Registered-workers table (queues/active/processed/failed/last-seen). Replaced at `/workers` by `WorkersPro` (adds status + unregister). |
| `/logs-classic` | `Logs` | Same SSE-driven activity feed as `LogsPro`, no pagination, simpler filter bar. |
| `/usage-classic` | `Usage` | Cumulative totals + runtime + storage. Storage row reads a type shape (`status.path`) the real `/storage` response doesn't return at this nesting, and renders uptime ×1000 too large — replaced at `/usage` by `UsagePro`, which fixes both. |
| `/s3-classic` | `S3Backup` | Read-only storage status + a static list of the server env vars that actually configure S3 backup (no form, no local state). |
| `/settings` | `Settings` | Connection (`baseUrl`, bearer token, "Test connection" round-trip), theme, and poll-refresh-interval. **The only settings page** — both Pro and classic pages read `connectionStore`/`themeStore`. |

## Not part of the router

- `src/pages/Alerts.tsx` — see "Not routed at all" above.
- `src/pages/NotFound.tsx` — the `*` catch-all route.

## Layout shell (every route)

`App.tsx` wraps every route above in one `AppLayout` (`Sidebar` + `Topbar` +
`<Outlet/>`). See [architecture.md](architecture.md) for the shell and
[components.md](components.md) for `Sidebar`/`Topbar`/`SidebarFooter` details,
including the **Topbar gap**: its page-title map only covers the classic-style
paths and the four Pro-at-plain-path routes, so all 8 `/…` Control-section
routes render a generic "bunqueue · bunqueue" title (known-issues.md).
