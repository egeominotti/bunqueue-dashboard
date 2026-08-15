---
title: Known issues
description: "A verified, non-glossed list of the bunqueue dashboard's current bugs and design constraints, each pointing at the exact file to look at."
---

# Known issues

Verified against the current source (not speculative), each entry cites the
exact file so you can confirm or fix it. None of these are catastrophic; the
dashboard is fully usable. They're documented here because "professional docs"
means being honest about the rough edges, not hiding them.

## [Bunqueue v2.8.59](https://github.com/egeominotti/bunqueue/releases/tag/v2.8.59) server-contract constraints

These constraints are in the upstream HTTP contract and cannot be made atomic
by a browser client. The dashboard fails closed where it can and names the risk
at the point of action:

- **Every DLQ retry path is unavailable.** The server exposes a read followed
  by a separate `POST /queues/:q/dlq/retry`, but the POST has no atomic
  precondition for job generation/identity, state or topology. Pinning the
  server, re-reading an exact failed ID and seeing empty topology is therefore
  insufficient: that job can disappear and a different job can be recreated
  under the same ID before the POST. Manual row retry, Jobs bulk retry,
  queue-wide retry and Copilot retry all fail closed.
- **Completed-job requeue is unavailable.** The upstream `retryCompleted`
  implementation resets a completed job but does not reconstruct dependency
  registration or the ordering guarantees of its original flow. The dashboard
  never calls the single-ID or queue-wide retry-completed route.
- **DLQ retention is display-only.** Saving a smaller `maxEntries` can
  immediately evacuate existing entries, while `maxAge` drives destructive
  expiry; neither path has an atomic generation/topology check for what it
  removes. The dashboard shows both server values read-only and omits
  `maxAge`/`maxEntries` from every save. Existing auto-retry can only be turned
  off, never enabled.
- **Other flow-destructive mutations are not topology-aware.** Cancel,
  Discard, Drain, Clean, Obliterate and DLQ Purge can delete a job that another
  queue still depends on. Bunqueue exposes neither reverse-dependency
  inspection nor an atomic conditional mutation, so those paths also fail
  closed. Session-owned Benchmark cleanup is the only queue-clean exception.
- **Cron creation is an upsert.** `POST /crons` has no create-only/CAS
  precondition. The dashboard blocks names visible in the current list and runs
  a fresh fail-closed preflight immediately before POST, but two clients racing
  the same absent name can still replace one another. The form and confirmation
  call the command an upstream, last-writer-wins upsert and require operators to
  authorize that behavior for a globally unique name.
- **Rate-limit and concurrency policies are write-only over HTTP.** Bunqueue's
  HTTP surface still exposes PUT/DELETE without matching reads, so the desired-
  state forms remain explicit replacements rather than editable cached values.
  Queue Control now complements them with live, target-pinned Bunqueue 2.8.59
  Queue SDK readback for the global rate limit, concurrency, remaining TTL, and
  saturation; write receipts are never presented as server truth.

Resolving the remaining mutation items completely requires generation/state/
topology-conditional APIs, flow-aware retry reconstruction, and create-only
cron semantics in Bunqueue itself.

## Adversarial audit pass (v0.0.32)

Every module was re-read against the invariants it assumes, each suspected
defect was challenged by an independent reviewer before being accepted, and the
92 that survived were fixed with regression tests (170 → 314 tests). The full
list is in [the changelog](https://github.com/egeominotti/bunqueue-dashboard/blob/main/CHANGELOG.md).
What matters for operators:

- **Network-facing agent access fails closed.** Non-loopback binds and
  reverse-proxied loopback binds require `AGENT_TOKEN`; it gates every bridged
  `/agent/*` route, including database, logs, config, and status reads. Remote
  policy is selected by the bind, `TRUST_PROXY`, forwarding headers, a public
  request Host, or explicit non-loopback allowed hosts/origins. Only genuinely
  loopback access keeps zero-configuration reads. The direct `:6800` listener
  stays loopback-only and is never the public bridge.
- **Network-facing admin-API access fails closed.** The all-in-one server uses
  the same remote-policy signals for `/api/*`: without `BUNQUEUE_TOKEN` it
  returns `403`, and with one configured every request needs that exact bearer.
  Enter it as the Server token in Settings. The header is forwarded unchanged,
  so a Bunqueue server using `AUTH_TOKENS` must accept the same value. Static
  deployments do not pass through this boundary and still need upstream/front-
  proxy authentication.
- **Wildcard Host policy is explicit.** The Host allowlist is enforced on every
  route, so `BIND_ADDR=0.0.0.0` must list every public/LAN name or address in
  `AGENT_ALLOWED_HOSTS` (origins in `AGENT_ALLOWED_ORIGINS` count too). It does
  not infer DHCP addresses, aliases, container service names, or Kubernetes pod
  IPs.
- **Proxied deployments:** the `/api` and `/agent` Origin gates compare the
  request's **host**, not its full origin, precisely so a TLS-terminating
  reverse proxy (browser sends `https://…`, the binary sees `http://…`) does
  not 403 every mutation while read-only GETs keep working. A proxy that
  preserves `Host` must first admit that public name via `AGENT_ALLOWED_HOSTS`
  or `AGENT_ALLOWED_ORIGINS`. A proxy that **rewrites** `Host` must also admit
  the rewritten raw Host, overwrite `X-Forwarded-Host`, and set
  `TRUST_PROXY=1`; that header is ignored for Origin matching by default,
  because a direct caller could otherwise declare itself same-origin. Listing
  the exact public origin in `AGENT_ALLOWED_ORIGINS` can replace the forwarded
  value for Origin policy, but never bypasses validation of the raw Host.
- **A timed-out `/db/query` is abandoned, not killed.** `Worker.terminate()`
  cannot preempt a synchronous `sqlite3_step`, so a runaway scan keeps burning
  its thread until SQLite finishes it. That thread is now counted and the number
  alive at once is capped (`MAX_CONCURRENT_QUERIES`), so the worst case is a
  bounded number of busy cores plus a clear "too many queries running" error
  rather than one leaked core per request. The timeout message no longer claims
  the query was aborted. Reducing this further needs a killable child process
  instead of a Worker — not done here.
- **Coverage floors are enforced on non-`.tsx` code** and were raised to
  71% lines / 66% functions. A JSX module enters the lcov denominator merely by
  being imported, so the aggregate tracked test *scope* rather than tested
  *behaviour*; the overall number is still reported by
  `scripts/check-coverage.ts`. React components remain largely uncovered by
  unit tests — that is a real gap, not a measurement artifact.

## Recently fixed (kept here for history)

A security + gate pass resolved these, no longer present:

- **`AGENT_TOKEN` end-to-end.** The browser agent client never sent the token,
  so a token-protected agent 401'd every control action, and the 401 popped the
  wrong (server) token prompt. The client now sends the agent token, the
  `auth:required` event is scoped (server vs agent), and Settings has an **Agent
  token** field that remains in memory for the browser session. See
  [agent.md](agent.md). Tokens are no longer sourced from `VITE_*`, where they
  would be visible in the public bundle.
- **DNS-rebinding read exposure closed.** The agent now enforces a **Host-header
  allowlist** (loopback + `AGENT_ALLOWED_HOSTS`) in addition to the Origin gate,
  so a page whose DNS was rebound to loopback can no longer read `/control/*` or
  `/db/*` over Origin-less same-origin GETs. The standalone binary applies the
  same gate to `/api`, `/agent` and assets on loopback and network binds.
- **Benchmark accounting is run-scoped.** Worker runs first require an empty
  dedicated per-tab queue, track the exact ids returned by every producer batch,
  and only ACK/count those ids. If another producer races the preflight, its jobs
  are returned to waiting and the benchmark stops. The UI does not expose a
  drain-only mode for arbitrary queues.
- **Alert channel secrets no longer persisted.** `alertsStore` kept `webhook`/
  `slack` targets (secret URLs) in `localStorage`; they're now memory-only.
- **`agent/` and `scripts/` are typechecked** by the build gate
  (`tsconfig.agent.json`), whereas the npm bin and agent code used to ship with no
  typecheck.

A performance + pagination pass resolved these, no longer present:

- **Per-poll fan-outs collapsed.** OverviewPro (was 8 req/poll), MetricsPro
  (was 22), DlqPro (was N+2) now issue 2 to 3 requests per poll via
  `GET /queues/summary`; JobsPro is single-queue server-paginated (was up to 25
  `jobs/list` per poll). Classic Jobs refuses its all-queue mode above 100
  queues rather than issuing up to 10,000 periodic requests; every permitted
  pool pins one target and is lifecycle-cancelled. `usePolledData` is now
  self-scheduling (at most one
  fetch in flight, no pile-ups) and **pauses while the tab is hidden**, except
  the **first** fetch, which always runs (same for `useThroughputSeries`'s first
  sample): a page opened in a background tab used to sit on "Loading…" (and the
  sidebar on "connecting") until focused.
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

## Database inspector, standalone timeout fixed

- **Compiled binaries now embed the disposable query Worker.** The standalone
  build passes both `scripts/serve.ts` and `agent/dbQueryWorker.ts` as
  entrypoints, so `/db/query` keeps the same 5-second wall-clock timeout as
  `bun start`. Queries remain read-only, statement-allowlisted and capped at
  500 rows in every distribution mode.

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
  reload, it re-seeds by content, not object identity. Flow jobs are read-only:
  v2.8.59 replaces the full payload and would otherwise erase the reserved
  parent/children metadata used by FlowReader.
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
- **docker.yml / pages.yml now run the full gate** (lint + build + test)
  before publishing, a commit rejected by CI could previously still ship as
  `edge` / to the public Pages site.

## Audit fix pass (earlier change-set)

A full-component adversarial audit fixed the following. Each was verified, then
fixed with the gate (build + lint + `bun test`) green; the agent + store fixes
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

## Classic-page correctness pass

- **Storage and DLQ shapes now match the live API.** The classic client reads
  `/storage` from `{ ok, data }`, and `DlqEntry` uses the nested
  `{ job, enteredAt, reason, error, attempts[] }` shape. The classic S3 page no
  longer masks disk-full, and a non-empty classic DLQ renders instead of
  crashing or showing blank identifiers.
- **Classic timestamps and totals are accurate.** Overview/Usage convert uptime
  milliseconds before formatting, Jobs uses `startedAt`/`completedAt`, and
  Queues gets its header totals from the global dashboard summary rather than
  the current page.
- **Legacy Jobs and Logs no longer advertise unavailable data.** Jobs reads an
  optional display name from job data, renders Cancel unavailable under the
  flow-safety policy, and refreshes the queue list every 30 seconds. Logs
  shows the SSE event type instead of a permanently unknown job name.

## UX gaps

- ~~**`src/pages/Alerts.tsx` is fully built but unreachable.**~~ **Fixed:** the
  Alerts page is now routed at `/alerts` with a Monitoring nav item, and a
  client-side engine (`src/lib/useAlertEngine.ts`, mounted app-wide via
  `AlertEngine`) evaluates the enabled rules against live metrics.

## Design limitations (not bugs, how bunqueue OSS works)

- **S3 operations require the local control agent.** `/s3` can now apply the
  whitelisted Bunqueue environment, inspect/list backups, create one on demand,
  and perform a stop-gated, snapshot-confirmed restore through the exact 2.8.59
  CLI. `/s3-classic` remains a read-only environment reference. Static hosting
  and arbitrary remote targets cannot run commands on a machine they do not
  manage.
- **Alerts are evaluated client-side, with real limits.** `useAlertEngine` now
  evaluates the rules in the browser (in-app toast + optional desktop
  Notification on each fresh threshold crossing), but: (1) it only runs **while a
  tab is open** (even backgrounded), so it is not away-from-desk paging; the
  email/webhook/slack **delivery channels still have no backend** (bunqueue OSS
  has no alerting engine, so wire them into your own monitoring or hosted bunqueue
  Cloud); (2) the **`p99_latency`** metric is **global only**, because bunqueue exposes
  latency percentiles keyed by TCP operation (push/pull/ack), not per queue, so a
  queue-scoped p99 rule evaluates the global max operation p99, not that queue's
  job latency.
- **Multiple pages cover overlapping ground on purpose** (three DLQ pages, two
  cron pages, `-classic` duplicates), this is the additive convention from
  `CLAUDE.md`, not accidental drift. See
  [pages.md](pages.md#sidebar--page-mapping).
