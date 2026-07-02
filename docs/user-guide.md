# User guide — every page, with screenshots

An illustrated tour of the bunqueue dashboard: one section per routed page, each
with a real screenshot and an explanation of what the page shows, what you can do
from it, and its honest gotchas. Screenshots were captured against a live seeded
server (queues `emails`, `image-resize`, `reports`, `notifications`, `benchmark`;
real completed jobs, DLQ entries, cron schedules, webhooks and workers), all in
the default dark theme at 1600px. For the route → component → API-client table
see [pages.md](pages.md); for verified endpoint shapes see
[api-mapping.md](api-mapping.md); for the current bug list see
[known-issues.md](known-issues.md).

Two page families coexist by design (the additive rule in `CLAUDE.md`): the
**Pro** pages (`src/pages/control/*`, client `lib/bq.ts`) are the complete
control surface and own the sidebar; the first-generation **classic** pages
remain reachable at `*-classic` routes and are covered in the appendix.

**Jump to:** [Overview](#overview) ·
[Queues](#queues) · [Jobs](#jobs-explorer) · [DLQ](#dead-letter-queue) · [Cron](#cron-jobs) ·
[Metrics](#metrics) · [Workers](#workers) · [Logs](#logs) ·
[Server](#server-control) · [Add Job](#add-job) · [Job Inspector](#job-inspector) ·
[Queue Control](#queue-control) · [DLQ Control](#dlq-control) · [Webhooks](#webhooks) ·
[Diagnostics](#diagnostics) · [Benchmark](#benchmark) ·
[Database](#database) · [Usage](#usage) · [S3 Backup](#s3-backup) · [Settings](#settings) ·
[Classic pages](#appendix--classic-pages) · [404](#not-found-404)


## Home

### Overview
**Route:** `/` — source: `src/pages/control/OverviewPro.tsx`

![Overview](screenshots/overview.png)

The landing page: a single-screen health check for the connected bunqueue server. It polls the bunqueue HTTP API (one `/dashboard` call plus one `/queues/summary` call per cycle — no per-queue fan-out), so it stays cheap even with many queues.

**What it shows**

- A connection banner with host, uptime, and RAM (in the screenshot: `localhost:6790`, uptime 50m, 435.0 MB, green "Online" pill).
- Two rows of stat cards: Completed (5,722), Failed (3), Waiting (41,300), Active, Error Rate (0.05%), DLQ (3), then Push/sec, Pull/sec, Queues (6, "3 cron active"), Total Pushed, API Keys, Uptime.
- **Queue Health** — cards for the first 6 queues with paused/active badge and W/A/C/F counts. The screenshot shows the seeded queues: `benchmark` (41,299 waiting), `image-resize`, `reports`, `notifications`, `maintenance`, and `emails` (310 completed), all active.
- **Recent Activity** — the last 8 job events (queue, short job ID, status, relative time) from the server's live SSE stream, updating in real time with automatic reconnect (2s backoff) if the stream drops.

**What you can do**

- Click any Queue Health card to open that queue's detail page (`/queues/:name`, the classic drill-in).
- Use **View All** next to Queue Health (→ Queues) and Recent Activity (→ Logs, a fuller UI over the same live stream).
- If a poll fails, click **Retry** on the offline banner.

**Notes**

- On connection loss after the first load, the banner turns amber — "Connection lost — showing last known data" with a "Stale" pill — while the page keeps rendering the last known numbers. (An older note describing the banner as permanently "Online" refers to a bug that has since been fixed; see `docs/known-issues.md`.)
- The "API Keys" card only reflects whether *this dashboard* has an auth token configured (0 or 1, "no auth" in the screenshot) — it is not a server-side key count.
- Queue Health caps at 6 queues; use View All for the rest.

## Queues section

### Queues
**Route:** `/queues` — source: `src/pages/control/QueuesOverview.tsx`

![Queues](screenshots/queues.png)

The fleet view of every queue on the connected bunqueue server, with per-state counts and an inline pause/resume switch on each row — the first control you reach for in an incident. Data comes from a single `GET /queues/summary` call per poll (no per-queue fan-out), marked "Live" in the header; polling pauses while the browser tab is hidden.

**What it shows**

In the screenshot, six seeded queues (`benchmark`, `emails`, `image-resize`, `maintenance`, `notifications`, `reports`) are listed alphabetically. Four summary cards at the top total the fleet: 41,300 waiting (almost all from `benchmark`), 2 active, 3 failed (all on `image-resize`), 0 paused. Each table row shows Waiting, Active, Completed, Failed and Delayed counts (e.g. `emails` with 313 completed, `notifications` with 3 delayed), plus a Status pill — green "Active" or orange "Paused".

**What you can do**

- **Pause or resume a queue in one click** via the amber pause / green play button on each row; a confirmation message appears above the table and the list refetches immediately.
- **Search queues by name** with the filter box (client-side, resets to page 1 as you type).
- **Open a queue's detail page** by clicking anywhere on its row (or the keyboard-focusable queue-name link), landing on `/queues/:name`.
- **Page through large fleets** — the list is client-paginated at 15 queues per page.
- **Retry on outage** — if the server is unreachable, an offline banner with a Retry button replaces silent failure.

**Notes**

- The four summary cards always total *all* queues, not just the ones matching your search filter.
- The "Paused" card counts paused *queues* (queues whose status pill reads Paused), not paused jobs.
- Failed pause/resume calls surface as a red error message — the API's HTTP-200-with-`{ok:false}` responses are treated as failures, not silent successes.

### Jobs Explorer
**Route:** `/jobs` — source: `src/pages/control/JobsPro.tsx`

![Jobs Explorer](screenshots/jobs.png)

The Jobs Explorer is where you browse, inspect, and act on individual jobs. It reads from the bunqueue HTTP API one queue at a time (there is no cross-queue job-list endpoint), with server-side pagination of 25 rows per page and live polling. In the screenshot the seeded `benchmark` queue is selected: 47,032 total jobs, 41,300 waiting, 5,729 completed, 3 failed (0.05% error rate), and a page of low-priority waiting jobs with their IDs, created timestamps, and per-row action icons.

**What it shows**

- Six server-wide stat cards: Total, Waiting, Active, Completed, Failed, Error Rate (these are whole-server totals, not just the selected queue).
- A queue dropdown (pre-selected from a `?queue=` URL parameter when present, otherwise the first queue), a status filter (All / Waiting / Active / Completed / Failed), and a text box that filters **the current page** by job ID.
- A table with checkbox multi-select: Job ID, Status, Priority (LOW / MEDIUM / HIGH), Created, Duration (completed − started; "—" until a job has run), Actions.

**What you can do**

- Click the eye icon to open any job in the Job Inspector (`/job?id=…`).
- Run per-row actions, shown only when the job's state allows them (via the shared `actionGates`): **Promote** a delayed job, **Retry** an active or DLQ'd (failed) job, **Requeue** a completed job, **Fail** an active job (with confirmation), **Cancel** a queue-resident job (with confirmation).
- Select rows and run the same actions in bulk. Each bulk button appears only if at least one selected job is eligible; results are reported honestly as "N succeeded, M not eligible / failed".

**Notes**

The ID search filters only the currently loaded page, not the whole queue. The API returns no total count, so pagination shows "Page N" with Next enabled whenever a full page arrived. Selections are cleared when you switch queue, status, or page — deliberately, so a bulk action can never hit rows you selected under a different view.

### Dead Letter Queue
**Route:** `/dlq` — source: `src/pages/control/DlqPro.tsx`

![Dead Letter Queue](screenshots/dlq.png)

The cross-queue DLQ dashboard: jobs that failed after exhausting all retries land here, and this page lets you monitor, retry, or purge them. It polls the bunqueue HTTP API live — the queue list on a slow 10s cadence, the selected queue's entries and stats on the fast poll.

**What it shows**

In the screenshot, the `image-resize` queue holds 3 failed entries. Four stat cards summarize the situation: **Total in DLQ** (3, flagged "Attention" in red — it reads "Healthy" in green at zero; this total spans *all* queues), **Top Reason** (`max_attempts_exceeded`), **Pending Retry** (0 in this queue), and **Failure Types** (1 distinct reason). Below, the **DLQ by queue** grid shows one clickable tile per queue that actually has entries. The table lists each entry's job ID (linked to the Job Inspector), reason badge, error text (`ImageMagick timeout after 30000ms on s3://uploads/photo-1002.jpg`), and when it entered ("12m ago").

**What you can do**

- Click a tile in the DLQ-by-queue grid (or use the dropdown) to select a queue.
- Filter the entries by failure reason, search by job ID, and sort newest/oldest first.
- **Retry All** or **Purge All** for the selected queue — both ask for confirmation and report how many entries were affected.
- Retry a single entry via the per-row refresh button (also confirmed).
- Click a job ID to open it in the Job Inspector.
- Page through large DLQs (25 entries per page).

**Notes**

The reason filter, job-ID search, and sort apply only to the currently loaded page of 25 — the server paginates but has no filter API. When a queue spans multiple pages, the sort options are labeled "(this page)" and an empty filter result tells you to check other pages with the pager.

### Cron Jobs
**Route:** `/cron` — source: `src/pages/control/CronManager.tsx`

![Cron Jobs](screenshots/cron.png)

The Cron Manager creates, lists, and deletes repeatable schedules on the bunqueue server (via its HTTP API — the local agent is not involved). The list polls live, so the "Next Run" and "Runs" columns update on their own; if the server is unreachable an offline banner appears with a Retry button. The screenshot shows three seeded schedules: `nightly-sales-report` on the `reports` queue (`0 3 * * *`), `hourly-digest` on `emails` (`0 * * * *`), and `cache-warmup` on `maintenance` running `every 300000ms` with 1 execution recorded.

**What it shows**

- A **Create schedule** form: Name, Queue, a **Cron / Every** toggle, the schedule field, and an optional **Data (JSON)** payload attached to every job the schedule enqueues.
- A table of existing schedules with **Name**, **Queue**, **Schedule** (the cron expression, or `every Nms` for interval schedules), **Next Run**, and **Runs** (execution count), paginated client-side at 15 per page.

**What you can do**

- **Create a schedule** — pick *Cron* for a cron expression (e.g. `0 9 * * *`) or *Every* for an interval in whole milliseconds greater than 0. The two are mutually exclusive: the toggle shows exactly one field and only that value is sent. Name and Queue are required, the Data field must be valid JSON, and the button disables while submitting so a double-click can't create duplicates. Success shows "Cron created ✓" for a few seconds.
- **Delete a schedule** — the trash icon on each row, behind a confirmation dialog that names the cron. If the delete fails, the error is shown in a banner instead of silently no-op'ing.

**Notes**

- There is no edit: to change a schedule, delete it and create a new one.
- The same page also serves `/cron-manager`; the older read-and-delete-only classic page lives at `/cron-classic`.

## Monitoring section

### Metrics
**Route:** `/metrics` — source: `src/pages/control/MetricsPro.tsx`

![Metrics](screenshots/metrics.png)

The live telemetry page for the whole server. It samples the bunqueue HTTP API's `/dashboard` overview once per second (independently of the normal page poll) and turns it into rolling 60-second charts, so you can see at a glance whether the system is keeping up. In the screenshot the seeded server has processed 5.8K jobs with 3 failures, and a large `benchmark` run has piled up a 41,303-job backlog that the depth chart flags as **steady**.

**What it shows**

- Four stat cards: all-time **Total Completed** / **Total Failed**, plus current **Push/sec** and **Pull/sec**.
- **Live Throughput** — pushed (pink), completed (green) and failed (red) jobs/sec over the last 60s, with a live legend.
- **Queue Depth** — backlog (waiting + active + delayed) over time, with a computed trend: *draining*, *accumulating* (with a ±slope in jobs/sec), or *steady*. The chart turns green when draining, amber otherwise.
- **Error Rate** — failed as a percentage of processed (0.05% here), with a success bar; the rate turns red above 5%.
- **Server Overview** — queued, processing, delayed, dead-letter counts, total pushed/pulled, and uptime.
- **Operation Latency** — avg / p50 / p95 / p99 in milliseconds for the `push`, `pull` and `ack` operations.
- **Per-Queue Metrics** — waiting / active / completed / failed per queue with a paused/active badge, paginated 15 per page (here: benchmark, image-resize, reports, notifications, maintenance, emails).

**What you can do**

- Watch throughput and backlog trend live — the "Live" dot in the header confirms polling is healthy.
- Judge whether a backlog is being worked off using the depth trend label rather than a single number.
- Page through the per-queue table on servers with many queues.
- Hit **Retry** on the offline banner if the server becomes unreachable (the page renders zeroed stats instead of erroring).

**Notes**

The charts build up client-side, so the 60s window starts empty when you open the page and pauses (without backfill) while the tab is hidden. The latency table's former always-0ms percentile-key bug is fixed on this page (see known-issues.md); the legacy `/metrics-classic` page still shows the raw payload quirks.

### Workers
**Route:** `/workers` — source: `src/pages/control/WorkersPro.tsx`

![Workers](screenshots/workers.png)

The Workers page is a live registry of every worker connected to the bunqueue server, so you can confirm your consumers are alive, see how much work each one has done, and evict a stuck registration. It polls `GET /workers` on the bunqueue HTTP API (not the control agent), and if the server stops answering, the "Live" dot next to the title disappears and an offline banner with a Retry button takes its place. In the screenshot, two seeded workers are registered — `notifications` (113 jobs processed) and `emails` (326 processed) — both **active**, both last seen 4 seconds ago, with zero failures and zero jobs currently in flight.

**What it shows**

- Four stat cards: **Total** workers, **Active** (green), **Stale** (amber when non-zero — workers that stopped heartbeating), and **Active Jobs** summed across all workers.
- A table with one row per worker: friendly name plus the full worker ID in monospace, the queues it consumes, an active/stale status pill, and per-worker Active / Processed / Failed counters with a relative "Last Seen" timestamp.
- An empty state ("No workers registered") when nothing has connected yet.

**What you can do**

- **Unregister a worker** with the trash icon on its row. A confirmation dialog warns you first, and a success or failure message appears above the table; the list refetches immediately either way.
- Watch the list refresh automatically — no manual reload needed (polling pauses while the browser tab is hidden).

**Notes**

- Unregistering is not a kill switch: a worker that is still running will simply **re-register on its next heartbeat**. Stop the worker process itself to remove it permanently.
- The table shows at most the **first 100 workers**; beyond that you get a "showing first 100 of N" hint rather than pagination.

### Logs
**Route:** `/logs` — source: `src/pages/control/LogsPro.tsx`

![Logs](screenshots/logs.png)

A live, filterable feed of every job event the bunqueue server emits over its SSE stream. It is driven by the same 250-event ring-buffer hook (`useActivityStream`) that powers Recent Activity on the Overview page — each page holds its own subscription and buffer — presented here with a fuller UI: counters, filters, search, and pagination. In the screenshot the stream is marked **Live** and shows seeded traffic on the `emails` and `notifications` queues — `job:pushed`, `job:active`, and `job:completed` events with per-job IDs, 29 total events (11 completed, 0 failed, 9 waiting, 9 active) at 2.6 events/s.

**What it shows**

- Six stat cards: Total Events, Completed, Failed, Waiting, Active, and Throughput (a rolling 5-second rate).
- An event table with a status badge, the raw event type (e.g. `job:completed`), the queue name, a relative timestamp, and the job ID — paginated 10 per page.
- A "Live" dot in the header that reflects the actual SSE connection; while disconnected with nothing buffered, the table shows "Connecting to the event stream…" (an idle but connected stream shows "Waiting for activity…").

**What you can do**

- Scope the stream to a single queue with the **All Queues** dropdown (this reopens the SSE subscription for that queue).
- Filter by status with the All / Waiting / Active / Completed / Failed segmented control.
- Search by job ID or queue name; changing any filter jumps back to page 1.
- Page through the buffered history with Previous / Next.

**Notes**

- Everything is in-memory and session-local: the buffer keeps only the most recent 250 events, and counters accumulate from when you opened the page — they reset on reload, on navigation, and when you switch the queue filter or connection target. They are not server-side totals.
- SSE events carry no job name, so the table shows the event type and job ID instead (the classic `/logs-classic` page's "Job Name" column is permanently "unknown" for the same reason).
- If the stream drops, the page auto-reconnects with a 2-second backoff.

## Control section

### Server Control
**Route:** `/server` — source: `src/pages/control/ServerControl.tsx`

![Server Control](screenshots/server.png)

This page supervises the bunqueue server **process** itself — lifecycle, launch configuration, on-disk storage and live logs. Unlike every other page, it talks to the local control agent on `127.0.0.1:6800` (RAM and connection counts alone come from the server's own `/health`, polled only while it runs). If the agent isn't running, the page shows how to start it (`bun start`) and reconnects automatically.

**What it shows**

In the screenshot the console reports **Running** — bunqueue v2.8.26, healthy, pid 15326, up 51m — with memory (435 MB rss), live connections (1 SSE), API endpoint, ports (6790 http / 6789 tcp), start time, agent address and launch command. Below: the Storage panel (40.7 MB on disk for `./data/bunq.db`, split into Database 39.4 MB / WAL 1.3 MB / SHM 32 KB, "written 20s ago") and Process logs tailing 479 lines — here a stream of red stderr `[Webhook] Failed to send webhook` errors from a seeded webhook pointing at an unreachable URL.

**What you can do**

- **Start / Stop / Restart** the server (Stop and Restart ask for confirmation).
- **Edit the launch config** — command, HTTP/TCP ports, SQLite data path, extra environment variables (with one-click chips like `AUTH_TOKENS`, `LOG_LEVEL`, `S3_BACKUP_ENABLED`). Ports are validated (1–65535, HTTP ≠ TCP) before saving.
- **Save config** or **Save & restart**; a "Restart to apply changes" hint appears when the edited config differs from what the live process was launched with.
- **Filter, follow, and download** the process log tail (All / Stdout / Stderr / Sys, timestamps toggle).

**Notes**

Config changes never apply in place — they take effect only on the next start/restart. The default command needs a global `bunqueue` binary; otherwise point it at a local entry file. Logs are a ring buffer (last ~800 lines), and if the agent dies mid-session an amber banner freezes the display and disables lifecycle buttons rather than showing stale "Running" state.

### Add Job
**Route:** `/add-job` — source: `src/pages/control/AddJob.tsx`

![Add Job](screenshots/add-job.png)

The manual job-enqueue form. Use it to push a test job (or thousands of them) into any queue — existing or brand new — with every enqueue option bunqueue supports, without writing a producer script. It talks straight to the bunqueue HTTP API via the `bq` client; the screenshot shows it connected to `localhost:6790` through the `/api` proxy.

**What it shows**

- A **Job** card with a Queue field (an autocomplete backed by the live queue list, refreshed every 30 s — type any name to create a new queue) and a monospace **Data (JSON)** editor pre-filled with `{ "hello": "world" }`.
- An **Options** card: Priority, Delay (ms), Max attempts (placeholder 3), Backoff (ms, placeholder 1000), Timeout (ms), and a **Custom job ID** field usable as an idempotency key, plus four toggles: `removeOnComplete`, `removeOnFail`, `durable`, `lifo`.
- A **Count** field (default 1) next to the pink **Add job** button.

**What you can do**

- Enqueue a single job — the result line confirms with the created job's ID.
- Bulk-enqueue by raising Count: values above 1 use the bulk endpoint, sending N copies of the same body in one request. Count must be an integer between 1 and 10000.
- Leave any option blank to use the server default; blanks are simply omitted from the request.
- Invalid JSON in the Data editor is caught client-side and shown under the editor before anything is sent.

**Notes**

- Bulk + **Custom job ID**: every element in the bulk request carries the *same* jobId, so the server dedupes them into a single job. The UI is honest about this — it reports the number of distinct IDs actually created (e.g. "Created 1 job"), not the requested count.

### Job Inspector
**Route:** `/job` — source: `src/pages/control/JobInspector.tsx`

![Job Inspector](screenshots/job-inspector.png)

The single-job deep dive: look up any job by its internal UUID or its custom/idempotency ID and drive its full lifecycle from one screen. The page is deep-linkable via `/job?id=<uuid>` and auto-loads the job on open — job IDs elsewhere in the dashboard (Jobs, DLQ) link straight here.

**What it shows**

The screenshot shows a completed job from the seeded `emails` queue: a header with the copyable job ID, queue name, and a green *Completed* badge; an overview grid (priority 0, attempts 0/3, progress 100%, created/started/completed timestamps, duration 119ms, custom ID); the **Data** payload (`{"name":"send","to":"ada@example.com","template":"welcome","locale":"it"}`); an **Edit data** card; the **Result** (`messageId`/`provider: ses`/`latencyMs: 53` — fetched separately from `GET /jobs/:id/result` and only for completed jobs, since the job object never embeds it); **Logs**; the **Timeline** (Waiting → Active → Completed with per-transition timestamps, plus worker/error details when present); and the **Backoff schedule** — here *Exponential (Default)* with ~2s/~4s/~8s for attempts 1–3. Failed jobs additionally get an **Error** card with the last failure message and full stacktrace.

**What you can do**

- Look up by job ID or custom ID (dropdown + Enter or **Look up**).
- Edit the JSON payload and **Save data**.
- Run state-gated actions from the right-hand rail — only actions the server would actually accept appear (shared `actionGates`). This completed job offers only **Requeue**; a delayed job gets **Promote**; an active job gets **Retry**, **Move to delayed**, force-**Fail** (optional reason, confirmed), **Discard**; queue-resident jobs get **Cancel (delete)** (confirmed), **Discard (to DLQ)**, **Set priority**, **Set delay**; a DLQ'd job gets **Retry from DLQ**.
- Append log lines to the job (level + message), refresh, or clear its logs.

**Notes**

The backoff schedule is a client-side preview: the server applies ±50% jitter (±20% for fixed backoff) at retry time, capped at 60m. The timeline is server-persisted but capped at 20 entries, so very retry-heavy jobs show only the most recent transitions.

### Queue Control
**Route:** `/queue-control` — source: `src/pages/control/QueueControl.tsx`

![Queue Control](screenshots/queue-control.png)

The Pro operations console for a single queue. Pick a queue from the dropdown and you get live counts plus every per-queue lever the bunqueue HTTP API exposes — pause/drain, delayed-job promotion, cleanup, rate limits, concurrency, stall detection and DLQ policy — all on one page. The queue list refreshes slowly (every 30 s); the selected queue's data polls on the fast live cadence.

**What it shows**

- A queue picker with an Active/Paused status dot; in the screenshot the seeded `benchmark` queue is selected and Active.
- Six compact count cards — waiting, active, completed, failed, delayed, paused (here: 41,299 waiting, zeros elsewhere).
- A Lifecycle card, Rate limit and Concurrency cards, and Stall detection / DLQ policy forms pre-filled from the server's current config (e.g. stall interval 30000 ms, max stalls 3; DLQ retry interval 3600000 ms, max age 604800000 ms, max entries 10000).
- The result of the last action ("Cleaned: 120" / an error) inline next to the picker.

**What you can do**

- **Pause / Resume** the queue (the button swaps based on current state).
- **Drain** waiting jobs (asks for confirmation).
- **Retry completed** jobs.
- **Promote delayed** jobs — optionally only the first *N* (blank = all).
- **Clean** — permanently delete up to *Limit* completed/failed jobs older than *Grace (ms)*, behind a confirmation prompt.
- **Set / Clear** the rate limit (max per window) and concurrency (max in-flight).
- **Save** stall-detection and DLQ-policy config; empty numeric fields are rejected with an inline error, except DLQ *Max age*, where blank means "no max age".

**Notes**

- `docs/pages.md` flags the Stall/DLQ forms as not resyncing on queue switch; in the current code they are remounted per queue (known-issues.md lists the cross-queue write as fixed) — but switching queues discards any unsaved form edits, and an external config change overwrites in-progress edits when the server values differ.
- Drain and Clean are destructive; Clean deletes jobs permanently.

### DLQ Control
**Route:** `/dlq-control` — source: `src/pages/control/DlqControl.tsx`

![DLQ Control](screenshots/dlq-control.png)

The single-queue operations view of the dead letter queue: pick one queue, inspect every job that exhausted its retries, and replay or discard them in bulk or one at a time. All calls go through the `bq` client to the bunqueue HTTP API. In the screenshot the **image-resize** queue is selected, its red **Entries** counter reads **3**, and the table lists three jobs dead-lettered with reason `max_attempts_exceeded` and the error `ImageMagick timeout after 30000ms on s3://uploads/photo-…jpg`, each with 2 attempts, entered 12m ago.

**What it shows**

- A queue selector listing every queue with its DLQ count (e.g. `image-resize (3)`); on load it auto-selects the first queue that actually has DLQ entries.
- An **Entries** stat card with the queue's total, tinted red when non-zero.
- A live-polling table (25 rows per page, paginated): Job ID, Reason badge, Error message, Attempts, and relative Entered time.
- Green/red feedback after each action (e.g. "Retried 3 entries"), and an offline banner with a Retry button if the API is unreachable.

**What you can do**

- **Retry all** — replays every DLQ entry for the selected queue, after a confirmation dialog that names the queue and the entry count.
- **Purge** — permanently deletes all DLQ entries for the queue, also behind a count-naming confirmation.
- **Retry one** — the per-row refresh icon replays a single job immediately (no confirmation).

**Notes**

- Per-row Retry has no confirm dialog — one click fires it.
- Three DLQ pages coexist on purpose: `/dlq` (DLQ Pro, cross-queue with filters), this page for focused single-queue operations, and the off-nav `/dlq-classic` (which is known-broken on non-empty DLQs — avoid it).
- Switching queue or page can't act on stale rows: results are tagged per queue+page, and the page number auto-clamps when the DLQ shrinks.

### Webhooks
**Route:** `/webhooks` — source: `src/pages/control/Webhooks.tsx`

![Webhooks](screenshots/webhooks.png)

Register HTTP callbacks that bunqueue fires when jobs change state — push a job event to your ops endpoint, alerting system, or Slack bridge without polling. The page talks to the bunqueue HTTP API (via the `bq` client) and auto-refreshes ("Live" in the header), pausing while the tab is hidden.

**What it shows**

- An **Add webhook** form: URL, optional queue scope (blank = all queues), optional HMAC signing secret, and event pills for `job.pushed`, `job.started`, `job.completed`, `job.failed`, `job.progress` — `job.completed` and `job.failed` are pre-selected, as in the screenshot.
- A table of registered webhooks with URL, subscribed events, queue scope, **Success / Fail** delivery counters, last-triggered time, and an enabled toggle. In the screenshot two hooks are registered: `https://ops.example.com/hooks/bunqueue` on `job.completed, job.failed` for all queues (0 / 479 — the red failure count means every delivery to that endpoint is failing) and `https://alerts.example.com/dlq` on `job.failed` scoped to the `image-resize` queue (0 / 0, never triggered).

**What you can do**

- **Add a webhook** — URL and at least one event are required; the button disables while submitting so a double-click can't register it twice.
- **Toggle a pill** to subscribe/unsubscribe events before adding.
- **Enable / disable** an existing webhook with its toggle (deliveries stop but the registration and counters are kept).
- **Delete** a webhook via the trash icon, behind a browser confirm dialog.

**Notes**

- Failed toggles or deletes surface in a red error banner instead of silently reverting — if you see one, the API rejected the change.
- The API returns the full webhook list; the table paginates it client-side at 15 rows per page.
- A climbing Fail counter with green Success at 0 (like the seeded ops hook) is your cue to check the receiving endpoint — the dashboard shows delivery outcomes but doesn't retry them for you.

### Diagnostics
**Route:** `/diagnostics` — source: `src/pages/control/Diagnostics.tsx`

![Diagnostics](screenshots/diagnostics.png)

A single-glance health page for the bunqueue server itself. It polls three read-only endpoints of the bunqueue HTTP API — `/health`, `/storage`, and `/stats` — and refreshes continuously (the green "Live" dot next to the title turns off if polling fails). Use it as your first stop when the dashboard feels wrong: is the server up, how long has it been running, is the disk full, and is anything actually connected to it?

**What it shows**

In the screenshot the server is up and healthy: Status `healthy` (green), Version `v2.8.26`, Uptime `52m`, and Disk `Healthy`. Below the stat row:

- **Connectivity** — live WebSocket clients (0) and SSE clients (1 — that's the dashboard's own activity stream), plus the last storage error reported by `/storage` (`none` here).
- **Memory** — the server process's heap used (75.0 MB), heap total (96.0 MB), and RSS (435.0 MB).
- **Lifetime totals** — cumulative counters since the server started tracking: 5,520 pushed, 5,816 pulled, 5,810 completed, 3 failed (accumulated from the seeded emails / image-resize / reports / notifications / benchmark queues).

**What you can do**

- Click **Ping** to measure a live round trip to `GET /ping`; the latency in milliseconds (or `unreachable`) appears on the button itself.
- Click **Retry** on the offline banner to refetch immediately if the server is unreachable.

**Notes**

The page degrades gracefully rather than erroring: if `/storage` or `/stats` fail, their cards render zeroed or disappear (Lifetime totals is hidden entirely without `/stats`), and a full outage shows the offline banner over empty cards. A full disk flips Disk to red **and** Status to `degraded`, because `/health` reports `ok: false` in that case. Ping is measured from your browser, so it includes any dev-proxy hop, not just server processing time.

### Benchmark
**Route:** `/benchmark` — source: `src/pages/control/Benchmark.tsx`

![Benchmark](screenshots/benchmark.png)

A load-testing rig that drives *real* traffic at the bunqueue server from your browser: parallel producers bulk-enqueue jobs while simulated workers pull, "process" (a configurable sleep), and ack them. Throughput is measured client-side, and the target queue genuinely fills and drains — the screenshot shows the page in its **Ready** state with the default config (queue `benchmark`, 5,000 jobs, 4 producers × 100-job push batches, 128-byte payloads, 4 workers pulling 100 at a time with 5 ms simulated work) and a **Server queue: benchmark** card already reporting 41,299 waiting jobs left over from a previous run.

**What it shows**
- Live run panel: Produced/Completed progress bars, plus Pushed, Completed, Push/sec, Done/sec, Elapsed, Active workers, Data volume, and Errors.
- A Throughput chart plotting enqueue rate vs completion rate per second.
- After a run, a Summary card with averages, data rate, and push-batch latency percentiles (p50/p95/p99/max), plus a run history table.
- Live server-side counts (waiting/active/completed/failed/delayed) for the target queue, polled every second — proof the load actually lands and drains.

**What you can do**
- Pick a preset — **Smoke** (200 jobs), **Standard** (5k), **Stress** (50k, 16×16), **Soak** (30 s duration mode) — or tune everything by hand.
- Switch between **Count** mode (push N jobs) and **Duration** mode (run for N seconds); set workers to 0 to produce only.
- Toggle **Durable** (fsync each job) and **Remove on complete**.
- **Stop** a run mid-flight, and **Clean queue** to purge benchmark jobs afterwards.

**Notes**
Clean queue cannot remove pulled-but-unacked (active) jobs — the server requeues them after its stall timeout, and the page reports how many remain. Run history is kept in memory only, so it is lost on reload.

## Management section

### Database
**Route:** `/database` — source: `src/pages/control/Database.tsx`

![Database](screenshots/database.png)

A read-only SQLite inspector for bunqueue's on-disk store, served by the local control agent's `/db/*` endpoints (port 6800), not the bunqueue API. Every connection is opened read-only, so nothing on this page — including hand-typed SQL — can modify data; the "read-only" badge in the header is literal.

**What it shows**

- Store metadata cards: SQLite version, on-disk size (file + WAL), journal mode, table and index counts. In the screenshot: SQLite 3.51.0, 39.5 MB, WAL, 6 tables, 12 indexes.
- A table list with live row counts — here `cron_jobs` (3), `dlq` (3), `job_results` (517), `jobs` (41,823), `migrations`, `queue_state`.
- A data grid for the selected table with type and PK badges per column. The screenshot shows `cron_jobs`: the seeded `nightly-sales-report` (reports), `hourly-digest` (emails) and `cache-warmup` (maintenance) entries, with BLOB cells abbreviated as `<blob 16 B>`.

**What you can do**

- Browse rows 50 per page; click a column header to sort (asc → desc → off).
- Filter by any column with `contains`, `=` or `≠` — press Enter or Filter.
- Click a row to open a detail drawer with full untruncated values (cells over 2,000 chars and BLOBs are abbreviated in the grid), pretty-printed JSON, and copy buttons.
- Switch to the **Schema** tab for columns, constraints, defaults, indexes, and the original DDL.
- **Export page** or **Export table** as CSV — the full export honors the current filter/sort and is capped at 200,000 rows.
- Run read-only SQL (`SELECT` / `WITH` / `EXPLAIN` / `VALUES` / `PRAGMA`) in the Query panel — ⌘/Ctrl+Enter runs, **Explain** shows the query plan, the last 10 queries stay in history, and results (capped at 500 rows) download as CSV or JSON.

**Notes**

- Queries are aborted after 5 seconds under `bun start`, but in the standalone compiled binaries that timeout is inactive — a pathological scan can pin the agent thread until it finishes (still read-only and row-capped).
- Before the bunqueue server has ever started, the page shows "No database yet" — start it once from Control ▸ Server to create the file.

### Usage
**Route:** `/usage` — source: `src/pages/control/UsagePro.tsx`

![Usage](screenshots/usage.png)

A single-screen summary of cumulative resource usage on the connected bunqueue server: lifetime job totals, error rate, process memory, uptime, and an honest disk-health verdict. It polls the bunqueue HTTP API (`GET /dashboard` and `GET /storage`) on the dashboard's global refresh interval — the "Live" dot next to the title indicates auto-refresh.

**What it shows**

- Six stat cards across the top. In the screenshot (server seeded with the emails / image-resize / reports / notifications / benchmark demo queues): **Completed 5.825**, **Failed 3**, **Waiting 41.300**, **Active 1**, **Error Rate 0.05%**, **Uptime 52m**. Failed turns red when non-zero; Error Rate (failed ÷ completed+failed) turns red above 5%.
- A **Runtime** card: jobs pushed (5.536) and pulled (5.832), heap used (76.0 MB), RSS (435.0 MB), and cron job count (3).
- A **Storage** card reading the real `/storage` disk-health flag: a green **Healthy — "Disk writes are being accepted."** panel in the screenshot, or a red **"Disk full — writes suspended"** panel (with the error and how long ago it started) when the server has stopped accepting writes.

**What you can do**

- Watch the totals tick up live while workers run — no manual refresh needed.
- Spot trouble at a glance: a red Failed/Error Rate card or a red Storage panel is your cue to head to DLQ Control or the server host.
- If the server is unreachable, an offline banner appears with a **Retry** button; the layout still renders with zeroed values instead of a blocking error.

**Notes**

- The page is read-only — there are no mutating actions here.
- Numbers use dot thousands separators by design (`5.825` = 5,825), matching the reference dashboard style.
- This Pro page replaces the classic `/usage-classic`, which renders uptime 1000× too large and always shows storage as "Healthy" (see `docs/known-issues.md`); `/usage` fixes both.

### S3 Backup
**Route:** `/s3` — source: `src/pages/control/S3BackupPro.tsx`

![S3 Backup](screenshots/s3.png)

A configuration helper for bunqueue's S3-compatible backup feature. The important thing to understand up front — and the page says so in a banner — is that bunqueue reads its S3 backup settings from **server environment variables** (`S3_BACKUP_ENABLED`, `S3_BUCKET`, `S3_REGION`, …). This form helps you assemble that configuration; it is stored locally in your browser and is **not** pushed to the server.

**What it shows**

- A status banner: "No backup configured / Set up S3 to protect your queue data" with an amber *Configure* badge (turns to *Backup configured / Ready* once a bucket name is entered).
- **Connection Settings** — Endpoint, Region (defaults to `us-east-1`), Bucket name, Access key ID, Secret access key, Backup schedule (Disabled / every 6, 12, or 24 hours), and an optional path prefix. Works with AWS S3, Cloudflare R2, MinIO, DigitalOcean Spaces, and any S3-compatible provider.
- **Backup History** — currently always the "No backups yet" empty state seen in the screenshot, since backups can't be triggered from the dashboard.

**What you can do**

- **Save Configuration** — persists endpoint, region, bucket, schedule, and prefix to `localStorage` (key `bq-dash-s3`). Credentials are deliberately excluded: keys live in memory only and are cleared on reload.
- **Test Connection** — calls the bunqueue HTTP API's `/storage` endpoint and reports "Server storage reachable" or "Server disk is full". It checks the *server's* disk, not your S3 credentials.
- **Backup Now** — permanently disabled; bunqueue exposes no endpoint to trigger a manual backup.

**Notes**

Known limitation (see `docs/known-issues.md`): S3 backup cannot actually be configured from the dashboard — this page only assembles values for you to set as server environment variables, and "Test Connection" does not validate the S3 settings themselves. A read-only classic variant lives at `/s3-classic`.

### Settings
**Route:** `/settings` — source: `src/pages/Settings.tsx`

![Settings](screenshots/settings.png)

The single settings page for the whole dashboard — both the classic and Pro (Control) families read the connection and theme it configures. It controls which bunqueue server the dashboard talks to (the `:6790` HTTP API; the local control agent on `:6800` is not configured here) and how the UI looks and refreshes. In the screenshot the **Connection** card points at `/api` (the dev proxy to `localhost:6790`), the bearer-token field is empty ("only if AUTH_TOKENS is set"), and the **Appearance & refresh** card shows the Dark theme with a 3-second refresh interval — matching the green `/api` pill and `localhost:6790` footer in the sidebar.

**What it shows**

- **Connection** — Server URL, an optional bearer token (masked, with a show/hide eye toggle), and Save / Test connection buttons with inline feedback.
- **Appearance & refresh** — Theme selector (Dark / Light) and the polling interval (1, 2, 3, 5, or 10 seconds) used by every auto-refreshing page.

**What you can do**

- **Change the server URL** and click **Save**. Edits are buffered until you save, so polling never retargets mid-keystroke. The URL must be an `http(s)` origin or a path starting with `/` — invalid input shows an error and is not saved. A "Saved ✓" confirmation appears briefly.
- **Set a bearer token** for servers running with `AUTH_TOKENS`.
- **Test connection** — calls the server's `/health` endpoint and reports the round-trip time and bunqueue version, or the error message on failure.
- **Switch theme** and **pick the refresh interval**; both apply immediately.

**Notes**

The bearer token is deliberately kept in memory only — it is never written to `localStorage`, so you must re-enter it after a page reload (or set `VITE_BUNQUEUE_TOKEN` at build time). The server URL and refresh interval do persist across reloads. A trailing slash on the URL is stripped automatically.

## Appendix — classic pages

The first-generation pages, kept intact per the additive rule. Several have
been superseded by a Pro page at the plain path (the classic version moved to a
`-classic` suffix); `QueueDetail` is still the only per-queue drill-in view.

### Queue Detail (classic)
**Route:** `/queues/:name` — source: `src/pages/QueueDetail.tsx`

![Queue Detail (classic)](screenshots/queue-detail.png)

**What it shows:** The single-queue drill-in, opened by clicking a row on the classic Queues list. The screenshot shows the `emails` queue: six stat cards (Waiting 0, Active 1, Completed 397, Failed 0, Delayed 0, Error Rate 0.00%), a 12-row Recent Jobs table (ID, Name from each job's `data.name` — here `send` — Status, Duration, Created) with a "View all jobs" link that opens Jobs pre-filtered to this queue, and a Configuration section with Rate Limit and Concurrency cards (Set/Clear with inline Saved/error feedback). Header buttons Pause/Resume, Drain, and Obliterate act on the bunqueue HTTP API; Drain and Obliterate ask for confirmation, and Obliterate returns you to the queue list. Data refreshes by polling — the green "Live" pill is decorative, not a real connection indicator.

**Differences vs the Pro page:** no Pro drill-in exists; Control ▸ Queue Control offers the same actions plus stall/DLQ configuration, but via a queue dropdown rather than a per-queue URL.

### Overview (classic)
**Route:** `/overview-classic` — source: `src/pages/Overview.tsx`

![Overview (classic)](screenshots/classic-overview.png)

**What it shows.** A single-poll health summary of the whole bunqueue server: six stat cards (Waiting, Active, Completed, Failed, DLQ, Error Rate — DLQ and Error Rate turn red when non-zero / above 5%), a Throughput card with pushed/pulled/completed/failed rates per second, a Resources card (uptime, heap, RSS, and a Healthy/Disk-full storage flag), plus compact Workers and Cron Jobs lists (first 6 of each). In the screenshot the seeded server has 41,300 waiting jobs, two active workers (`emails`, `notifications`) and three crons (`nightly-sales-report`, `hourly-digest`, `cache-warmup`). Read-only — everything comes from one polled `api.overview()` call to the bunqueue HTTP API.

**Differences vs the Pro page (`/`):** OverviewPro adds a connection banner, a per-queue health grid, and a live Recent Activity feed.

**Known issue:** uptime renders ~1000× too large (milliseconds passed to a seconds-based formatter) — the "36d" shown is really about 53 minutes. See `docs/known-issues.md`.

### Queues (classic)
**Route:** `/queues-classic` — source: `src/pages/Queues.tsx`

![Queues (classic)](screenshots/classic-queues.png)

**What it shows.** A live-polled, read-only list of every queue on the bunqueue server, 20 per page. Four stat cards summarize Waiting / Active / Delayed / DLQ counts; below them, each row shows the same counts per queue plus an Active/Paused badge — in the screenshot, six seeded queues (benchmark with 41,299 waiting, image-resize with 3 DLQ entries in red, reports, notifications with 3 delayed, maintenance, emails), all Active. The search box filters by name, and clicking any row drills into `/queues/:name` (QueueDetail). There are no actions here — pausing, draining, and limits live in Queue Control.

**Differences vs the Pro page:** `/queues` (QueuesOverview) fetches the full list in one `bq.queuesSummary()` call and adds inline pause/resume; this classic page is paginated and read-only.

**Known limitation:** the header cards and search only cover the current 20-row page, not all queues (see `docs/known-issues.md`).

### Jobs (classic)
**Route:** `/jobs-classic` — source: `src/pages/Jobs.tsx`

![Jobs (classic)](screenshots/classic-jobs.png)

**What it shows.** A cross-queue job explorer over the bunqueue HTTP API: six stat cards (in the screenshot: 47,157 total, 41,300 waiting, 5,854 completed, 3 failed, 0.05% error rate) above a merged job table — here mostly completed `notifications` and `emails` jobs plus one waiting `maintenance` job. Filter with the queue dropdown and the All/Waiting/Active/Completed/Failed segments, search by job ID, and cancel a job with the trash icon (confirm prompt). "All Queues" fans out over the first 25 queues, 40 jobs each, newest-first, capped at 100 rows; arriving via `?queue=` preselects a queue.

**Known limitations:** the Name column is always "unknown", the Duration column is always "—", and searching by name is dead — real jobs carry none of the fields this page reads (see `docs/known-issues.md`).

**Differences vs the Pro page:** `/jobs` (JobsPro) is the replacement — single-queue, server-paginated, with multi-select bulk actions and correct Name/Duration.

### DLQ (classic)
**Route:** `/dlq-classic` — source: `src/pages/Dlq.tsx`

![DLQ (classic)](screenshots/classic-dlq.png)

**What it shows.** The first-generation dead-letter view: a queue selector (with per-queue DLQ counts), a "DLQ Entries" stat card, a paginated entries table (Job ID, Name, Reason, Attempts, Failed), and Retry all / Purge buttons with confirmation prompts. It polls the bunqueue HTTP API via the legacy `api` client.

**Known bug — this page is broken for real entries.** `api.ts` models a flat `DlqEntry` shape the server never returns (entries are nested `{ job, enteredAt, reason, attempts[] }`). With a non-empty DLQ the page crashes rendering the `attempts` array — the screenshot shows exactly that: the error boundary ("Something went wrong … Objects are not valid as a React child") with a Reload button, instead of the seeded queues' entries.

**Differences vs the Pro pages:** use `/dlq` (DlqPro, cross-queue dashboard with filters and per-row retry) or `/dlq-control` (single-queue actions) — both read the correct nested shape and work.

### Cron (classic)
**Route:** `/cron-classic` — source: `src/pages/Cron.tsx`

![Cron (classic)](screenshots/classic-cron.png)

**What it shows.** A live-polling, read-only list of every scheduled job on the bunqueue server, paginated 15 per page. Each row shows the schedule's name, target queue, its trigger — a cron expression or an interval (`every 300000ms`) — the next run time, and how many times it has executed. In the screenshot three schedules are registered: `nightly-sales-report` on the **reports** queue (`0 3 * * *`), `hourly-digest` on **emails** (`0 * * * *`), and `cache-warmup` on **maintenance** every 5 minutes (2 runs so far). The only action is the trash icon, which deletes a schedule after a confirmation prompt; if the server is unreachable an offline banner appears with a retry button.

**Differences vs the Pro page.** This page is list + delete only — creating schedules lives in Cron Manager at `/cron` (which the sidebar's "Cron Jobs" entry now opens). No known bugs; the classic/Pro duplication is intentional.

### Metrics (classic)
**Route:** `/metrics-classic` — source: `src/pages/Metrics.tsx`

![Metrics (classic)](screenshots/classic-metrics.png)

**What it shows.** A read-only, auto-refreshing dump of the raw `GET /dashboard` payload from the bunqueue API. The top row is live throughput per second (Pushed/Pulled/Completed/Failed — 1.1 / 1.1 / 0.7 / 0.0 in the screenshot). Below sit lifetime Totals (5,582 pushed, 5,871 completed, 3 failed across the seeded emails/image-resize/reports/notifications/benchmark workload), server Memory (heap 78/96 MB, RSS 436 MB), latency percentiles per operation (`push`/`pull`/`ack` × p50/p95/p99), latency averages (`pushMs`/`pullMs`/`ackMs`), and the server's in-memory collections (`jobIndex` 41,881, `queuedTotal` 41,306, …). Nothing is clickable; it refreshes at the global polling interval from Settings.

**Differences vs the Pro page:** `/metrics` (MetricsPro) adds a rolling 60-second throughput chart, a success-rate gauge, and per-queue counts — this page is flat key-value lists only.

Note: the percentile list once rendered broken values (`[object Object]`/zeros); per `docs/known-issues.md` it now correctly flattens the nested per-operation percentiles.

### Workers (classic)
**Route:** `/workers-classic` — source: `src/pages/Workers.tsx`

![Workers (classic)](screenshots/classic-workers.png)

**What it shows.** A live, read-only table of every worker registered with the bunqueue server, polled via the same `api.overview()` call the classic Overview uses. Two stat cards summarize Total and Active counts (2 / 2 in the screenshot). Each row lists the worker's name and full ID (here `notifications` and `emails` workers from the seeded demo), the queues it consumes, and its Active / Processed / Failed job counts plus a relative "Last Seen" timestamp (9s ago). The list is client-paginated at 20 rows; if the server truncates the list at 100 workers, an amber "showing first N of M" hint appears. Nothing here is clickable — the page is purely for monitoring throughput.

**Differences vs the Pro page:** `/workers` (WorkersPro) adds an active/stale status indicator and a per-row Unregister action.

### Logs (classic)
**Route:** `/logs-classic` — source: `src/pages/Logs.tsx`

![Logs (classic)](screenshots/classic-logs.png)

**What it shows.** A live activity feed of job events streamed over SSE from the bunqueue API — the same stream the Pro Logs page uses. Six stat cards count events since the page opened (Total, Completed, Failed, Waiting, Active) plus a rolling Throughput rate (2.8/s in the screenshot). Below, a table lists each event's status badge, job name, queue, relative timestamp, and job ID, 10 per page. Filter with the queue dropdown (list refreshed every 30 s), the All/Waiting/Active/Completed/Failed segments, or the search box (matches job ID, name, or queue). In the screenshot, seeded `emails` and `notifications` jobs cycle through Waiting → Active → Completed. Counters reset on reload — this is a session view, not history.

**Differences vs the Pro page:** `/logs` adds an event-type column (working around this page's known bug: Job Name here is permanently "unknown" because SSE events carry no name) and export/clear controls.

### Usage (classic)
**Route:** `/usage-classic` — source: `src/pages/Usage.tsx`

![Usage (classic)](screenshots/classic-usage.png)

**What it shows.** A read-only snapshot of cumulative server usage, polled live from the bunqueue HTTP API via a single `api.overview()` call. Four stat cards give lifetime totals — in the screenshot the seeded demo workload shows 5,600 jobs pushed, 5,890 completed (green), 3 failed (red), 5,896 pulled (blue). Below them, a **Runtime** card lists uptime, heap used (79.0 MB), RSS (436.0 MB), workers ("2 active / 2") and cron jobs (3), and a **Storage** card shows Status and Path. There is nothing to click; if the server is unreachable the page renders zeroed values with an offline banner instead of an error.

Two known bugs (see `docs/known-issues.md`): the Storage card reads a response shape `/storage` never returns, so Status is always "Healthy" (masking a real disk-full condition) and Path is always "—"; and uptime is milliseconds fed to a seconds formatter, so the screenshot's "37d 11h 31m" is really about 54 minutes.

**Differences vs the Pro page:** `/usage` (UsagePro) fixes both issues — honest disk-full detection and correct uptime — and adds an error-rate figure.

### S3 Backup (classic)
**Route:** `/s3-classic` — source: `src/pages/S3Backup.tsx`

![S3 Backup (classic)](screenshots/classic-s3.png)

**What it shows.** A read-only reference for bunqueue's S3 snapshot backups. A banner reminds you that backups are configured on the **server via environment variables** and cannot be toggled from the dashboard. Two cards follow: **Storage status** (polls `GET /storage` on the bunqueue API — the screenshot shows Disk "Healthy" and an empty Path) and **Configuration (server env)**, a static cheat-sheet of the eight variables that actually control backups (`S3_BACKUP_ENABLED`, `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, access/secret keys, `S3_BACKUP_INTERVAL`, `S3_BACKUP_RETENTION`) with defaults. There is nothing to click — use it as a lookup while editing your server's env.

**Known issue:** the classic `api.ts` client misreads the `/storage` response shape, so Disk always reads "Healthy" (even when the disk is full) and Path is always "—"; `/storage` returns no path at all.

**Differences vs the Pro page:** `/s3` (S3BackupPro) adds a local-only config-builder form, a working "Test Connection", and an honest storage check via `bq.storage()`.

## Not found (404)
**Route:** `*` — source: `src/pages/NotFound.tsx`

![Not found](screenshots/not-found.png)

Any unknown path renders this catch-all inside the normal layout shell — the
sidebar stays usable and a **Back to Overview** button returns to `/`. Note the
Topbar falls back to a generic "bunqueue · bunqueue" title here, as it does for
every route missing from its title map (see
[known-issues.md](known-issues.md)).
