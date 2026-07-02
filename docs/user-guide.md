---
title: User guide
---

# User guide

An illustrated, section-by-section tour of the bunqueue dashboard. **Every
dashboard section has its own page** in the sidebar — each with a real
screenshot and a detailed, source-grounded walkthrough of what it shows, every
action you can take, its states and gating, the API calls behind it, and its
honest gotchas.

Screenshots were captured against a live seeded server (queues `emails`,
`image-resize`, `reports`, `notifications`, `benchmark`, `maintenance`; real
completed jobs, DLQ entries, cron schedules, webhooks and workers) in the
default dark theme.

::: tip Two page families, by design
The **Pro** pages (`src/pages/control/*`, client `lib/bq.ts`) are the complete
control surface and own the sidebar — they're documented below. The
first-generation **classic** pages remain reachable at `*-classic` routes and are
covered in the [Classic pages appendix](/guide/classic). For the full route →
component → API-client table, see [Pages & routes](/pages).
:::

## Home

- [**Overview**](/guide/overview) — the landing page: connection banner, headline
  stat cards, per-queue health grid, and a live activity feed.

## Queues

- [**Queues**](/guide/queues) — the fleet view: every queue with per-state counts
  and inline pause/resume.
- [**Jobs Explorer**](/guide/jobs) — server-paginated jobs for a queue, with
  filters, multi-select and bulk actions.
- [**Dead Letter Queue**](/guide/dlq) — cross-queue DLQ dashboard: reasons,
  per-row retry, retry-all / purge.
- [**Cron Jobs**](/guide/cron) — list and create scheduled jobs (cron expression
  or interval).

## Monitoring

- [**Metrics**](/guide/metrics) — rolling throughput chart, queue-depth trend,
  latency percentiles, per-queue counts.
- [**Workers**](/guide/workers) — registered workers, active/stale status, and
  per-worker unregister.
- [**Logs**](/guide/logs) — the live SSE event feed with filters and search.

## Control

- [**Server Control**](/guide/server) — start / stop / restart the bunqueue
  process via the local control agent, with live logs.
- [**Add Job**](/guide/add-job) — enqueue a job with payload, options, priority
  and delay.
- [**Job Inspector**](/guide/job-inspector) — a single job's full timeline,
  payload, result and state-gated actions.
- [**Queue Control**](/guide/queue-control) — per-queue actions plus rate-limit,
  concurrency and stall/DLQ configuration.
- [**DLQ Control**](/guide/dlq-control) — single-queue dead-letter actions.
- [**Webhooks**](/guide/webhooks) — register, test and remove webhook endpoints.
- [**Diagnostics**](/guide/diagnostics) — connectivity and health checks.
- [**Benchmark**](/guide/benchmark) — drive synthetic load and watch throughput.

## Management

- [**Database**](/guide/database) — the read-only SQLite inspector: tables,
  schema, rows, and query runner.
- [**Usage**](/guide/usage) — cumulative usage totals and runtime/storage facts.
- [**S3 Backup**](/guide/s3) — a config builder and honest storage check for S3
  snapshot backups.
- [**Settings**](/guide/settings) — connection target, polling interval, theme,
  and agent token.

## Appendix

- [**Classic pages**](/guide/classic) — the first-generation view pages, kept
  intact, and the 404 catch-all.
