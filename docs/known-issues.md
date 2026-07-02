---
title: Known issues
description: "A verified, non-glossed list of the bunqueue dashboard's current bugs and design constraints, each pointing at the exact file to look at."
---

# Known issues

Verified against the current source (not speculative), each entry cites the
exact file so you can confirm or fix it. None of these are catastrophic; the
dashboard is fully usable. They're documented here because "professional docs"
means being honest about the rough edges, not hiding them.

## Recently fixed (kept here for history)

A performance + pagination pass resolved these, no longer present:

- **Per-poll fan-outs collapsed.** OverviewPro (was 8 req/poll), MetricsPro
  (was 22), DlqPro (was N+2) now issue 2 to 3 requests per poll via
  `GET /queues/summary`; JobsPro is single-queue server-paginated (was up to 25
  `jobs/list` per poll). `usePolledData` is now self-scheduling (at most one
  fetch in flight, no pile-ups) and **pauses while the tab is hidden**.
- **Every list is paginated**, see the `Pagination` component in
  [components.md](components.md). Server-paginated where the API supports it
  (queues, DLQ via offset/limit/total; jobs via offset/limit + `hasNext`), client-paginated for full-list endpoints (crons, webhooks, workers, activity).
- **`usePolledData` race fixed** with a generation guard (last-to-START wins).
- **MetricsPro/`Metrics` latency** now reads the real nested per-operation
  percentiles (`push`/`pull`/`ack` × p50/p95/p99) instead of always-0.
- **Uptime** no longer rendered ~1000× too large (ms→s) on OverviewPro/MetricsPro.
- **Topbar titles** now cover all Control routes (no more "bunqueue · bunqueue").
- **`bq.call()`** now throws on HTTP-200-with-`{ok:false}` (except `health()`), so failed cancel/purge/retry surface as errors instead of false success.
- **Responsive**: fluid root type (`clamp()`), a mobile nav drawer + hamburger, responsive padding. See [components.md](components.md).

A stability re-check resolved these, no longer present:

- **`StatusBadge` no longer crashes on a missing/undefined `status`.**
  `status.toLowerCase()` had no guard; two nav-reachable callers
  (`LogsPro.tsx`, `JobTimeline.tsx`) passed `e.status`/`e.state` with no
  fallback, unlike `JobsPro`/`JobInspector` which already defaulted to
  `'waiting'`. Fixed at the root (`StatusBadge.tsx`) so all six callers are
  covered: empty/undefined status now renders as "unknown" instead of
  throwing.
- **`AreaChart` no longer blanks on a `NaN`/`Infinity` point.** `finite()`
  sanitizes each value to `0` before it reaches the max computation or the
  SVG path builder, so one bad point degrades to a dip instead of corrupting
  every series' path data.

## UI/UX pass (this change-set)

A four-auditor UI/UX sweep (52 findings) was applied on top of the stability
sweep. Highlights: theme-aware semantic status colors (`text-success/warning/
danger`, the dark-palette 400 shades failed WCAG AA on the light theme),`Field` now wires label→input (`useId`), focus-visible rings across the shell
and kit, standardized `{ok,text}` green/red action feedback on every mutating
control, destructive confirms name their target and counts (Clean had NO
confirm), Enter submits the create forms, honest empty states when a filter, not the data, is empty, `live={!error}` on Metrics/Diagnostics, DLQ job IDs
link to the Job Inspector, `/usage` and `/workers` graduated to Pro pages
(`/cron` now serves CronManager; classics remain at `*-classic`), Settings
buffers the server URL (was retargeting all polling per keystroke), and a new
**Database** section: read-only SQLite inspector (agent-side `readonly`
connection, tables, schema/indexes/DDL, sortable grid, query runner with
history/EXPLAIN/CSV/JSON export). `scripts/dev.ts` now spawns services
directly instead of via `bun run` wrappers, which did not forward SIGTERM and
were the root cause of the recurring orphaned vite/agent processes.

## Database inspector, known limitation

- **In the standalone compiled binaries** (`release.yml` / `scripts/serve.ts`
  via `bun build --compile`), the `/db/query` runner has **no wall-clock
  timeout**. The timeout runs the query in a disposable Worker, and
  `bun build --compile` does not embed the worker module, so `queryWithTimeout`
  degrades to a synchronous run there (still read-only, statement-allowlisted
  and row-capped at 500, just not interruptible). A deliberately pathological
  scan can therefore pin the agent's thread in a compiled binary until it
  finishes. Under `bun start` / `bun run agent` (the normal path) the Worker
  timeout is active and aborts runaway queries at 5s. `/db` reads are protected
  by the Origin allowlist (not the optional `AGENT_TOKEN`, which gates only
  state changes, the browser client sends no agent token).

## Stability sweep (adversarially verified, earlier change-set)

A multi-dimension bug hunt (every finding independently verified by refute /
reproduce / impact passes before fixing) resolved the following, gate green, with regression tests where practical (`test/format.test.ts`, `test/manager.test.ts`):

- **Live activity feed no longer misorders bursts under StrictMode.** The
  `setEvents` updater in `useActivityStream` mutated its captured batch via
  `.reverse()`, an impure updater React invokes twice in dev, flipping a
  multi-event flush back to the wrong order. The reverse now happens once, outside the updater.
- **`formatDuration` can no longer render "1m 60s" / "60.0s"**, the remainder
  is derived from a single up-front rounding (119,700 ms → "2m 0s").
- **JobInspector**: a failed lookup now distinguishes 404 ("Job not found", URL param cleared so the deep-link effect can't silently re-load the previous
  job over the failure) from network/5xx errors (real message shown; a valid
  job is no longer reported as "removed" when the server is merely down).
- **JobsPro / DlqPro / DlqControl stale-view race fixed** (QueueControl's
  tagging pattern): after switching queue/filter/page, the previous view's rows
  can no longer stay rendered, with live action buttons, under the new
  selection, so Retry/Cancel can't fire against the wrong entity.
- **JobDataEditor no longer wipes unsaved edits** on every action-driven job
  reload, it re-seeds by content, not object identity.
- **ServerControl shows an amber "agent unreachable" banner** (and disables
  lifecycle buttons, freezes the uptime ticker) when the status poll fails
  after a successful one, it used to keep asserting "Running / healthy" with
  a live-ticking uptime for a dead agent.
- **Agent orphan fix**: `agent/index.ts` now handles SIGINT/SIGTERM and stops
  the managed bunqueue server before exiting (Ctrl-C on `bun start` used to
  leave it running, holding :6790 and the SQLite db). `scripts/dev.ts` waits
  10s (was 2s) so the agent's SIGTERM→SIGKILL escalation can complete.
- **Agent log pipe flushes the final unterminated chunk**, a crash cause
  written without a trailing newline used to vanish from Process Logs.
- **Agent spawn-failure race**: a `start()` whose spawn throws while a stale
  `stop()` is finalizing now clears `proc`/`runningConfig` (status no longer
  reports a dead pid + launch config for a stopped server).
- **ErrorBoundary resets on ANY navigation** (`location.key`, was pathname
  only), re-clicking the crashed section's nav item or navigating between
  `/job?id=X` variants now recovers instead of appearing permanently broken.
- **CopyButton**: falls back to `execCommand('copy')` on insecure (plain-HTTP)
  origins, the documented Docker deployment, and flashes a red ✕ on failure
  instead of silently doing nothing.
- **Theme flash fixed**: an inline pre-paint script in `index.html` applies the
  persisted light theme before the bundle loads (was a dark→light flash on
  every visit).
- **`react-router` joined the `react-vendor` chunk** (the manualChunks regex
  missed it, in React Router 7 it holds the whole router; `react-router-dom`
  is a shim), so app-only deploys no longer re-download the router.
- **Standalone binary proxy fixed**: `scripts/serve.ts` now strips
  `content-encoding`/`content-length`/`transfer-encoding` from proxied
  responses (Bun's fetch decompresses bodies but kept the headers, behind any
  gzip proxy every `/api` response failed with `ERR_CONTENT_DECODING_FAILED`), and missing `/assets/*` files 404 (matching the Docker image's Caddy) instead
  of returning index.html to a stale chunk import.
- **`strictPort: true`**: Vite now fails fast when :5273 is taken instead of
  silently serving on :5274 while `bun start`'s banner points at the stale
  instance.
- **docker.yml / pages.yml now run the full gate** (biome + build + test)
  before publishing, a commit rejected by CI could previously still ship as
  `edge` / to the public Pages site.

## Audit fix pass (earlier change-set)

A full-component adversarial audit fixed the following. Each was verified, then
fixed with the gate (build + biome + `bun test`) green; the agent + store fixes
ship with reproducing tests (`test/agent-server.test.ts`, `test/manager.test.ts`, `test/sse.test.ts`, `test/s3store.test.ts`).

- **Control agent is no longer unauthenticated-RCE-by-design.** `agent/` now
  enforces an **Origin allowlist** and **locked CORS** (never `*`, ACAO is
  reflected only for allowed origins) and rejects any request carrying a
  disallowed `Origin` (403) before it reaches the `ProcessManager`. A malicious
  tab's cross-origin `PUT /control/config` → `POST /control/start` can no longer
  set + run a command. Non-browser callers (curl) still work. Set `AGENT_TOKEN`
  for an extra bearer-token gate on state-changing requests; configure allowed
  origins via `AGENT_ALLOWED_ORIGINS`. Handler logic is factored into
  `agent/server.ts` (unit-tested). See [agent.md](agent.md).
- **Agent stop/start race fixed.** A `stop()` awaiting an old process could
  orphan a process a concurrent `start()` brought up (manager reported
  "stopped" while a server was still running). `ProcessManager` now guards every
  `onExit`/`stop()` mutation by a monotonic process token.
- **`ConfigForms` cross-queue write fixed.** `StallForm`/`DlqConfigForm` now
  `useEffect(() => setC(config), [config])` and `QueueControl` renders them with
  `key={queue}`, so switching queue no longer saves queue A's stall/DLQ config
  onto queue B. Save now surfaces errors inline (was silent + unhandled rejection).
- **`useActivityStream` connection indicator fixed.** `connected` now flips true
  on *any* delivered frame (the handshake carries `data.connected` with no
  `event:` line), so an idle-but-live queue no longer shows "Connecting…" forever;
  and the stream now **auto-reconnects** (2s backoff) after a clean end / server
  restart instead of going silently dead.
- **`OverviewPro` banner reflects connection loss.** After the first successful
  poll, a later failure now shows an amber "Connection lost, showing last known
  data / Stale" banner instead of a permanent green "Online" over frozen numbers.
  Recent Activity rows now show the real `queue`/`jobId` (were all "unnamed").
- **`setRateLimit` now actually applies.** `api.setRateLimit` sent `{max,duration}`
  but the server reads `{limit}`, so the classic `QueueDetail` rate-limit control
  silently no-op'd while showing "Saved". It now sends `{limit}`; the dead
  "Duration (ms)" input was removed. `api.ts`'s `request()` now also throws on
  HTTP-200-`{ok:false}` (except `storage()`/`health()`), matching `bq.call()`.
- **S3 secret no longer persisted.** `s3Store` uses `partialize` to keep
  `accessKeyId`/`secretAccessKey` in memory only, they are no longer written to
  `localStorage` in plaintext.
- **`AddJob` bulk-with-custom-ID** now reports the real created count
  (`new Set(ids).size`) and caps/validates `Count` (≤10000).
- **`DlqControl`** no longer fetches unused `dlqStats` (whose failure blanked the
  whole page). **`DlqPro`** keeps the `Pagination` control mounted when a
  page-scoped reason/search filter matches nothing (was a navigation trap), and
  labels its page-scoped sort honestly on multi-page queues.
- **`QueueDetail` Recent Jobs** now shows real Name (`data.name`) and Duration
  (`startedAt`/`completedAt`) instead of "unknown" or a placeholder dash.
- **`Workers`** surfaces a "showing first 100 of N" hint when the list is
  truncated. **`ServerControl`** validates ports (1 to 65535, HTTP≠TCP) before
  restart. **`Topbar`** guards `decodeURIComponent` (malformed URL no longer
  crashes the shell). **`useThroughputSeries`** has an in-flight guard (no
  overlapping polls). **`Webhooks`** enable/disable toggle has an accessible name.
- **App-wide `ErrorBoundary`.** `src/components/ErrorBoundary.tsx` wraps the
  whole shell, so a single render throw shows a recoverable fallback instead of
  blanking the entire app.

The items below are the ones **still** open (mostly confined to the off-nav
`*-classic` legacy pages, kept per the additive convention).

## Correctness, silent wrong data (off-nav legacy pages)

- **`lib/api.ts`'s `storage()` and the classic `Usage`/`S3Backup` pages
  disagree with the real `/storage` shape.** The server wraps the payload, `GET /storage` → `{ ok, data: { diskFull, error, since } }` (see
  [api-mapping.md](api-mapping.md)), but `api.ts:76` types it as
  `{ ok, status: StorageStatus }` and `S3Backup.tsx`/`Usage.tsx` read
  `data?.status?.diskFull` / `data?.status?.path`. Neither field exists at
  that nesting, so both pages always render "Healthy" and a blank Path, **masking a real disk-full condition**. `lib/bq.ts`'s `storage()` has the
  correct `{ ok, data }` type and is used correctly by `S3BackupPro`'s "Test
  Connection", the bug is confined to the classic `api.ts` path. Note
  `/storage` never returns a `path` field either way; that row is dead
  regardless of the wrapping fix.
- **`lib/types.ts`'s `DlqEntry` models a shape the server doesn't return.** The
  real DLQ entry is `{ job: Job, enteredAt, reason, error, attempts:
  AttemptRecord[] }`, nested. `api.ts`'s `DlqEntry` declares top-level
  `id`/`jobId`/`name`/`failedAt`, which don't exist on the real object (masked
  by its `[key: string]: unknown` index signature, so TypeScript doesn't catch
  it). `Dlq.tsx` (classic) renders `e.jobId ?? e.id` (→ blank), `e.name`
  (→ always "unknown"), and uses `e.id` as the React key (→ `undefined`, duplicate-key warnings). `DlqPro`/`DlqControl` use the corrected
  `DlqEntryFull` from `bqTypes.ts` and read `e.job.id`, they're fine.
- **The classic `Dlq.tsx` also crashes on a non-empty DLQ**, it renders
  `{e.attempts}` (an `AttemptRecord[]`) directly as a table cell → React
  "Objects are not valid as a React child". Confined to `/dlq-classic`
  (off-nav); the default `/dlq` (`DlqPro`) is unaffected.

## Correctness (off-nav legacy pages, component-sweep findings, report-only)

A full component sweep confirmed these in the classic pages; left as-is per the
additive rule (the primary Pro routes are unaffected):

- **`Overview.tsx` (`/overview-classic`) and `Usage.tsx` (`/usage`) render uptime
  ~1000× too large**, `/dashboard`'s `stats.uptime` is milliseconds but both pass
  it to the seconds-based `formatUptime` without the `/1000` the Pro pages apply.
  Note `/usage` IS nav-reachable; fix would be a one-liner if it graduates to a
  Pro page.
- **`Jobs.tsx` (`/jobs-classic`) Duration column always renders a placeholder dash and Name/search are
  dead**, it reads `processedOn`/`finishedOn` and `name`, none of which exist on
  real jobs (see the API-shape gotchas).
- **`Queues.tsx` (`/queues-classic`) header cards labeled as global totals only sum
  the current 20-row page.**
- **`Logs.tsx` (`/logs-classic`) "Job Name" column is permanently "unknown"**, SSE events carry no `name` (the Pro LogsPro now shows the event type instead).

## Performance (off-nav legacy pages)

- **`Jobs.tsx` (classic, `/jobs-classic`) polls the full queue list every 3s.**
  `usePolledData(() => api.queues(500), [])` (Jobs.tsx:32) fetches up to 500 full
  queue rows on the fast global cadence purely to feed the queue dropdown and the
  `slice(0, 25)` fan-out list, data that changes rarely. The primary route
  `/jobs` → `JobsPro` already throttles the equivalent to 30s
  (`{ intervalMs: 30000 }`), so the real user path is efficient. Left as-is per
  the additive rule (classic pages are reported, not edited in place); the fix, if
  ever wanted, is to add `{ intervalMs: 30000 }` to that call. An efficiency pass
  applied the same throttle to every *Pro* page (QueueControl, LogsPro, AddJob, JobsPro overview) and split the DLQ/Metrics duplicate `/dashboard` polls.

## UX gaps

- **`src/pages/Alerts.tsx` is fully built but unreachable.** See
  [pages.md](pages.md#not-part-of-the-router). If you're looking for an
  "Alerts" nav item and can't find one, this is why.

## Design limitations (not bugs, how bunqueue OSS works)

- **S3 backup cannot be configured from the dashboard.** Both `/s3` and
  `/s3-classic` are explicit about this: bunqueue reads `S3_BACKUP_ENABLED`, `S3_BUCKET`, etc. from the **server process's environment**. `S3BackupPro`'s
  form is a local-only (`localStorage`) convenience for assembling that env
  config to paste elsewhere, it has no effect on the running server, and
  "Backup Now" is permanently disabled.
- **Alerts have no backend.** `alertsStore` persists rules/channels to
  `localStorage` only; nothing evaluates them. bunqueue OSS has no alerting
  engine, wire the rules into your own monitoring, or use hosted bunqueue
  Cloud.
- **Multiple pages cover overlapping ground on purpose** (three DLQ pages, two
  cron pages, `-classic` duplicates), this is the additive convention from
  `CLAUDE.md`, not accidental drift. See
  [pages.md](pages.md#sidebar--page-mapping).
