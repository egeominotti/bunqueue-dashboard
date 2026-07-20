---
title: Pages & routes
description: "The verified route-to-page-to-API-client table for every page in the dashboard, both classic and Pro."
---

# Pages

Every route registered in `src/App.tsx`, what it renders, which API client it
uses, and what it actually does. Verified against the current source; where a
route's label in the sidebar doesn't match the page family you'd expect, that's
called out explicitly below.

## How to read this page

Two page families coexist by design (see [architecture.md](architecture.md)):

- **Pro** (`src/pages/control/*`), the corrected, complete-control surface.
  Uses `lib/bq.ts`. This is where new work happens.
- **Classic** (`src/pages/*`, first-gen), the original read-mostly view pages.
  Uses `lib/api.ts`. Kept intact per the additive rule; not actively extended.

Every nav-reachable route now serves a Pro page except `/settings` (the only
settings page, shared by both families) and `/alerts` (client-side alert
rules). Each classic page remains routable at a `-classic` suffix.

## Route table (from `src/App.tsx`)

| Path | Component | Family | Client |
| --- | --- | --- | --- |
| `/` | `control/OverviewPro` | Pro | `bq` |
| `/overview-classic` | `Overview` | Classic | `api` |
| `/queues` | `control/QueuesOverview` | **Pro** | `bq` |
| `/queues/:name` | `control/QueueDetailPro` | **Pro** | `bq` |
| `/queues-classic` | `Queues` | Classic | `api` |
| `/queues-classic/:name` | `QueueDetail` | Classic | `api` |
| `/jobs` | `control/JobsPro` | **Pro** | `bq` |
| `/jobs-classic` | `Jobs` | Classic | `api` |
| `/dlq` | `control/DlqPro` | **Pro** | `bq` |
| `/dlq-classic` | `Dlq` | Classic | `api` |
| `/cron` | `control/CronManager` | **Pro** | `bq` |
| `/cron-manager` | redirect → `/cron` | n/a (legacy alias) | n/a |
| `/cron-classic` | `Cron` | Classic | `api` |
| `/flows` | `control/Flows` | Pro | `bq` |
| `/metrics` | `control/MetricsPro` | **Pro** | `bq` |
| `/metrics-classic` | `Metrics` | Classic | `api` |
| `/workers` | `control/WorkersPro` | **Pro** | `bq` |
| `/workers-classic` | `Workers` | Classic | `api` |
| `/logs` | `control/LogsPro` | **Pro** | `bq` + SSE |
| `/logs-classic` | `Logs` | Classic | `api` |
| `/server` | `control/ServerControl` | Pro | `bq` (+ control agent) |
| `/add-job` | `control/AddJob` | Pro | `bq` |
| `/jobs/bulk-add` | `control/BulkAddJobs` | Pro | `bq` |
| `/job` | `control/JobInspector` | Pro | `bq` |
| `/queue-control` | `control/QueueControl` | Pro | `bq` |
| `/dlq-control` | `control/DlqControl` | Pro | `bq` |
| `/webhooks` | `control/Webhooks` | Pro | `bq` |
| `/diagnostics` | `control/Diagnostics` | Pro | `bq` |
| `/alerts` | `Alerts` | Client-side rules (see below) | `alertsStore` + `useAlertEngine` |
| `/benchmark` | `control/Benchmark` | Pro | `bq` |
| `/database` | `control/Database` | Pro, read-only SQLite inspector via the control agent's `/db/*` endpoints | `bq.db` (agent) |
| `/mcp` | `control/McpServer` | Pro (static setup guide) | none |
| `/usage` | `control/UsagePro` | **Pro** | `bq` |
| `/usage-classic` | `Usage` | Classic | `api` |
| `/s3` | `control/S3BackupPro` | **Pro** | `bq` + `s3Store` |
| `/s3-classic` | `S3Backup` | Classic | `api` |
| `/settings` | `Settings` | Classic (the only settings page) | `api`, `connectionStore`, `themeStore` |
| `*` | `NotFound` | n/a | n/a |

`/cron-manager` was a duplicate route serving the same `CronManager` page as
`/cron`; it is now a `<Navigate replace>` redirect to `/cron` so old bookmarks
keep working.

## Sidebar → page mapping

`src/components/layout/Sidebar.tsx` (`NAV`, also consumed by the Cmd/Ctrl-K
command palette) groups nav items into four sections plus the root Overview:

- **Queues**: Queues (QueuesOverview) · Jobs (JobsPro) · Dead Letter Queue
  (DlqPro) · Cron Jobs (CronManager) · Flows.
- **Monitoring**: Metrics (MetricsPro) · Workers (WorkersPro) · Logs
  (LogsPro) · Alerts.
- **Control**: Server · Add Job · Bulk Add · Job Inspector · Queue Control ·
  DLQ Control · Webhooks · Diagnostics · Benchmark, all Pro, all `bq`.
- **Management**: Database · MCP · Usage (UsagePro) · S3 Backup (S3BackupPro)
  · Settings (classic).

There are still **three DLQ pages** (`DlqPro` at `/dlq`, `DlqControl` at
`/dlq-control`, classic `Dlq` at `/dlq-classic`), intentional per the additive
rule, not an oversight: `/dlq` is the cross-queue dashboard, `/dlq-control` the
single-queue triage surface.

## Home & Control (Pro, `bq`)

| Route | Page | Behaviour |
| --- | --- | --- |
| `/` | `OverviewPro` | Connection banner (host · uptime · RAM) that flips to an amber "Connection lost, showing last known data / Stale" state when a poll fails after the first success; two rows of stat cards, a Queue Health grid, and a live Recent Activity feed from `useActivityStream()`. |
| `/server` | `ServerControl` | Start/Stop/Restart via the control agent (amber "agent unreachable" banner + disabled lifecycle buttons when the agent poll dies); storage row (SQLite main/WAL/total-on-disk/last-modified); always-editable config form with port validation, a "Save & restart" shortcut and a "restart to apply" hint; colour-coded live process-log tail (`stdout`/`stderr`/`sys`). |
| `/add-job` | `AddJob` | Enqueue with full options (priority/delay/maxAttempts/backoff/timeout/jobId/removeOnComplete/removeOnFail/durable/lifo), single or bulk via a `Count` field (validated, ≤10000; bulk with a custom ID reports the real deduped created count). |
| `/jobs/bulk-add` | `BulkAddJobs` | Bulk enqueue: paste a JSON array or NDJSON (one JSON value per line), validated client-side, submitted via `bq.addJobsBulk`. |
| `/job` | `JobInspector` | Look up a job by ID (deep-linkable via `?id=`). Kv overview, Data (editable), Result (fetched separately via `GET /jobs/:id/result`), Error + stacktrace, Timeline (persisted state transitions, capped at 20), Backoff schedule preview, job logs, children. Actions gated by the job's actual state via `lib/jobActions.ts::actionGates`. 404 ("Job not found") is distinguished from network/5xx errors. |
| `/queue-control` | `QueueControl` | Per-queue counts; Lifecycle card (pause/resume/drain/retry-completed/promote-delayed/clean, destructive ops confirmed with target + counts); Limits cards (rate-limit, concurrency); Stall-detection and DLQ-policy forms (re-seeded per queue via `key={queue}`, errors surfaced inline). |
| `/cron` | `CronManager` | Create a schedule (cron expression *or* interval-in-ms, mutually exclusive via a segmented control, with a client-side next-runs preview) and list/delete existing ones. |
| `/dlq-control` | `DlqControl` | Single-queue DLQ triage: entries table (job id linked to the Job Inspector, reason, error, attempts, entered), Retry-all / Retry-one / Purge with confirmation. |
| `/dlq` | `DlqPro` | Cross-queue DLQ dashboard: totals/top-reason cards, a clickable per-queue DLQ-count grid, then a filtered (reason + search) + sortable, server-paginated entries table for the selected queue, with Retry-all/Purge-all and per-row Retry. |
| `/webhooks` | `Webhooks` | Create (URL, optional queue scope, optional HMAC secret, event checkboxes from `WEBHOOK_EVENTS`), list with success/failure counts and last-triggered, enable/disable toggle, delete (confirmed). |
| `/diagnostics` | `Diagnostics` | Health/version/uptime/disk cards, a manual Ping button (round-trip ms), WS/SSE client counts, storage error, memory (heap/RSS), lifetime totals. |
| `/benchmark` | `Benchmark` | Interactive load benchmark: push and/or drain (pull-batch + ack-batch) against a queue in `count` or `duration` mode, presets, live throughput chart, run history. Logic in `control/benchmark/` (engine, useBenchmark, RunHistory). |
| `/flows` | `Flows` | Client-side DAG visualizer for a job flow (parent/children/dependsOn) with its own layout engine (`lib/flowLayout.ts`, no graph library). |
| `/database` | `Database` | Read-only SQLite inspector over the agent: tables, schema/indexes/DDL, sortable + filterable data grid, row detail drawer, and a query runner (SELECT-only allowlist, 500-row cap, history, EXPLAIN, CSV/JSON export). |
| `/mcp` | `McpServer` | Static setup/reference guide for the `bunqueue-mcp` stdio MCP server: config snippets with copy buttons, not a live monitor. |

## Queues / Jobs / Metrics / Logs / Usage / S3 (Pro, `bq`)

| Route | Page | Behaviour |
| --- | --- | --- |
| `/queues` | `QueuesOverview` | Queue list over `bq.queuesSummary()` (search, totals, client-side pagination); click a row to drill into `QueueDetailPro`. |
| `/queues/:name` | `QueueDetailPro` | Single-queue drill-in on the same building blocks as `QueueControl`, plus obliterate, a live backlog-depth sparkline, recent jobs, and jump-off links to this queue's Jobs and DLQ views. |
| `/jobs` | `JobsPro` | Single-queue, server-paginated job explorer: queue + status filters, stat cards, checkbox multi-select. Row and bulk actions are state-gated via the shared `actionGates`; bulk actions run `Promise.allSettled` and report "`N` succeeded, `M` failed" honestly. |
| `/metrics` | `MetricsPro` | Live throughput area chart (rolling 60s via `useThroughputSeries`), error/success-rate gauge, server-overview Kv list, per-queue counts table. Latency strip reads the real per-operation percentiles (`push`/`pull`/`ack` × p50/p95/p99). |
| `/logs` | `LogsPro` | Paginated, filterable (queue/status/search) view over the same live SSE stream `useActivityStream` drives on `OverviewPro`, a fuller UI over the identical 250-event ring buffer, not a separate data source. |
| `/workers` | `WorkersPro` | Registered-workers table over `bq.workers()`, with active/stale status and a confirmed per-row Unregister. Caps at 100 rows with a truncation hint. |
| `/usage` | `UsagePro` | Cumulative totals, error rate, runtime, and an honest Storage health card from `bq.storage()` (red "Disk full, writes suspended" when `diskFull`). Renders uptime correctly (`stats.uptime` is ms). |
| `/s3` | `S3BackupPro` | Local-only (`s3Store`) form to assemble S3-compatible backup settings; bunqueue OSS reads these from **server environment variables**, so this page cannot push them to the server. "Test Connection" calls `bq.storage()`; "Backup Now" is permanently disabled (no server endpoint). |

## Alerts (client-side)

`/alerts` (`src/pages/Alerts.tsx` + `alertsStore`) manages threshold rules and
channels; the rules are evaluated **in the browser** by `useAlertEngine`
(mounted app-wide via `AlertEngine`): 15s poll, edge-triggered breach
detection, per-rule cooldown, in-app toast + optional desktop Notification.
Delivery channels (email/webhook/slack) have **no backend** in bunqueue OSS, so
see [known-issues.md](known-issues.md) for the real limits.

## First-gen view pages (Classic, `api`)

These predate the Pro pages. All are off-nav (`-classic` routes) and
superseded by a Pro page, but their shared API shapes and basic readouts remain
correct and regression-safe.

| Route | Page | Behaviour |
| --- | --- | --- |
| `/overview-classic` | `Overview` | Stat cards + throughput + resources + a compact workers/crons summary. |
| `/queues-classic` | `Queues` | Paginated queue list with client-side page search and global header totals. |
| `/queues-classic/:name` | `QueueDetail` | Single-queue drill-in: pause/resume/drain/obliterate, counts, recent jobs, embeds `pages/queue/QueueConfig.tsx`. |
| `/jobs-classic` | `Jobs` | Same shape as `JobsPro` minus multi-select/bulk; uses job-data display names, real timestamps, state-gated Cancel and a 30s queue-picker refresh. |
| `/dlq-classic` | `Dlq` | Single-queue DLQ table using the real nested `{ job, enteredAt, reason, attempts[] }` shape. |
| `/cron-classic` | `Cron` | List + delete only (no create form, use `/cron`). |
| `/metrics-classic` | `Metrics` | Kv dumps of the raw `/dashboard` payload (latency/collections/totals/memory), useful for inspecting the raw shape. |
| `/workers-classic` | `Workers` | Registered-workers table, no status/unregister. |
| `/logs-classic` | `Logs` | Same SSE feed as `LogsPro`, with event type, queue, timestamp and job id. |
| `/usage-classic` | `Usage` | Cumulative totals + runtime + honest storage health and disk-full timestamp. |
| `/s3-classic` | `S3Backup` | Read-only storage status + a static list of the server env vars that configure S3 backup. |

## Settings

`/settings` (`Settings`, classic) is the only settings page, used by both
families: connection (`baseUrl` buffered until Save, server bearer token,
agent token, "Test connection" round-trip), theme, and poll-refresh interval.

## Layout shell (every route)

`App.tsx` wraps every route above in one `AppLayout` (`Sidebar` + `Topbar` +
`<Outlet/>`), with two error boundaries (app-wide + per-page, reset on any
navigation) and a single `<Suspense>` around the outlet so the shell never
blanks during a lazy-chunk load. See [architecture.md](architecture.md) for the
shell and [components.md](components.md) for `Sidebar`/`Topbar`/`SidebarFooter`
details.
