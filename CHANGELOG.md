# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The version is owned by `package.json` (starting at `0.0.1`) and bumped on every
push to `main`; `.github/workflows/release.yml` tags and publishes `v<version>`
to match.

**Process (see `CLAUDE.md`):** before every push to `main`, record changes under
`## [Unreleased]` and bump `package.json`'s `version`. For every version, rename
`[Unreleased]` to the bumped version and start a fresh empty `[Unreleased]`. The
release workflow publishes the matching version section (or `[Unreleased]`) as
the GitHub Release body.

## [Unreleased]

## [0.0.31] - 2026-07-20

### Fixed
- **Classic pages now follow the current bunqueue API contract.** Storage reads
  the nested `data` payload, DLQ rows use their nested job and attempt records,
  job names come from payload data, durations use the current timestamps,
  uptime is converted from milliseconds, queue totals are global rather than
  page-local, and log rows identify their event.
- **Classic job actions no longer silently fail or offer invalid cancellation.**
  Cancellation is state-gated and surfaces request failures, while queue
  discovery refreshes periodically.
- **Standalone database queries retain their five-second safety timeout.** The
  query worker is embedded as a second executable entry point on local and
  release builds; worker startup failures can no longer fall back to a blocking
  synchronous query.
- **Dependency audit is clean.** VitePress and Vite were upgraded to versions
  that remove the vulnerable transitive Vite/esbuild packages.
- Updated the architecture, API mapping, page guide, deployment snippets, and
  known-issues documentation to match the corrected behavior.

### Changed
- **Copilot provider SDKs load on demand.** The Copilot panel's minified lazy
  chunk drops from about 685 kB to 182 kB, with unused providers split into
  separate chunks.
- Documentation builds now isolate Node's local-storage state and suppress the
  known lazy Mermaid/VitePress chunk warning while preserving bundle checks.
- Added regression coverage for database queries through the disposable worker.

## [0.0.30] - 2026-07-05

### Fixed
- **Cron preview accepted the wrong month for named months.** The live schedule
  preview rejected `jan` as invalid and shifted every other month name one early
  (`feb` previewed January, `dec` previewed November) — a 0-indexed month table
  against cron's 1-based months. Names now resolve correctly (jan=1 … dec=12).
- **The Job Inspector could save an edited payload to the wrong job.** Editing
  the Data field, then looking up a different job with a byte-identical payload,
  kept the unsaved edit and let Save write it to the new job. The editor is now
  keyed per job id.
- **The Database inspector kept a stale filter across table switches.** Choosing
  a filter column/value on one table then switching to another left the old
  inputs in place, causing a "no such column" error or a silent wrong-table
  filter; the filter bar now resets per table.
- **Queue Control's config forms vanished silently when their load failed.** A
  failed stall/DLQ-config fetch removed the whole form with no message; it now
  shows a retry card, matching Queue Detail.
- **A save then immediate re-edit of a queue's stall/DLQ config was clobbered**
  by the save's own echo on the next poll. The form now recognizes its own
  just-saved value and preserves the re-edit.
- **CSV export from the Database inspector** now quotes a bare carriage return
  (which was splitting a row) and neutralizes spreadsheet formula injection on
  text cells (a value starting with `= + - @`), while keeping real numbers numeric.
- **A queue with no processed jobs showed an error rate of "0.00%"** instead of
  "—" (0% from zero data is a claim, not a measurement).
- **Bulk job actions no longer overstate the confirm count.** A mixed-state
  selection now confirms and acts on only the eligible rows.
- **The backoff preview no longer implies a delay before a job's first run**
  (attempt 1 is the initial execution — backoff applies only to retries).
- **Duration and latency readouts no longer render "1000ms"** where rounding
  tipped a value to a full second; they show "1.0s" / "1.00s".
- **The DLQ retry/purge failure toast** read "Retri failed" / "Purg failed"; it
  now reads "Retry failed" / "Purge failed".
- **The live activity stream** splits SSE frames on the earliest boundary, so a
  mixed CRLF/LF stream can't merge two events into one.
- **Copilot:** stopping a turn before its first token no longer leaves a
  permanent "Thinking…" bubble, and a stopped turn's late teardown can no longer
  cancel a newly-started turn's confirmations or release its busy lock.
- **Demo mode** (`?demo` / `#demo` local preview) no longer loses its call-to-action
  and the Flows default graph after the first navigation drops the query string.

### Changed
- **Shared `ConfigLoadError`** extracted to the config-forms module so Queue
  Control and Queue Detail render one component.
- **The Database row-detail drawer** fetches each truncated cell once instead of
  re-fetching every truncated cell on every 6s poll.
- Added regression tests (cron month names, duration/latency rounding, SSE frame
  boundaries). The one remaining Biome warning (`useActivityStream` effect deps)
  is now a documented intentional-reconnect ignore, so `check` is fully clean.

## [0.0.29] - 2026-07-04

### Changed
- **Queue detail: "Recent jobs" now sits above "Jobs by priority."** Recent
  activity reads first, with the priority histogram directly beneath it.

## [0.0.28] - 2026-07-04

### Fixed
- **Docs hero subtitle now centered.** VitePress's prose paragraph styles reset
  the alignment the hero inherits, so the intro paragraph rendered left-aligned
  under the centered heading; pinned `text-align: center` on it.

### Added
- **Per-priority histogram on a queue.** Queue detail now charts how many waiting
  jobs sit at each priority level, so you can see at a glance whether high-priority
  work is starving the rest. The data already shipped in the queue payload and was
  being dropped.
- **Memory tools in Diagnostics.** A "Compact (GC)" button forces a garbage
  collection + internal compaction and reports the freed RSS; a "Heap statistics"
  panel loads the `bun:jsc` breakdown (object counts + top object types) on demand
  for leak hunting; and a copyable Prometheus scrape URL for Grafana/Alertmanager.
- **Set job progress.** The Job Inspector can now set an active job's progress
  (0–100), which also refreshes its stall heartbeat and fires a `job.progress`
  webhook. Added `setJobProgress`/`gc`/`heapStats`/`prometheusUrl` to the client.
- **Advanced enqueue options.** Add Job exposes tags, a group id, a dedup unique
  key, job dependencies, and a backoff strategy (flat / fixed / exponential).
- **Advanced cron options.** Create-schedule exposes a max-executions cap, run-
  immediately, skip-missed-on-restart, and per-spawned-job options (max attempts,
  backoff, timeout).

## [0.0.27] - 2026-07-04

### Added
- **Social/OG cards on the live demo.** The demo is the project's most-shared
  link but shipped with only a `<title>`, so it unfurled as a bare, image-less
  link on Twitter/Slack/Reddit/LinkedIn. `index.html` now carries a meta
  description, canonical, Open Graph and Twitter `summary_large_image` tags, and
  the OG image is served from the app root.
- **Demo-mode conversion CTA.** In the hosted demo the sidebar now shows a small
  prompt with a copy-to-clipboard `bunx bunqueue-dashboard`, a Star-on-GitHub
  button, and a Docs link, so a wowed visitor has a path to install instead of a
  dead end. Hidden outside demo mode.

### Changed
- **Sharper positioning.** README and docs hero now lead with the one ownable
  differentiator ("the only queue dashboard that also runs the server"), gloss
  what bunqueue is (a fast, Redis-free, Bun-native job queue) for cold visitors,
  and name who it's for.
- **Richer npm discoverability.** Expanded `package.json` keywords with the
  high-intent terms people actually search (`bullmq-alternative`,
  `queue-dashboard`, `job-queue-ui`, `dlq`, …) and pointed `homepage` at the
  live demo instead of a README anchor.

## [0.0.26] - 2026-07-04

### Fixed
- **DLQ Control entries table clipped its action column on mobile.** The wrapper
  used `overflow-hidden` (unlike every sibling table), so at ~390px the Retry and
  Inspect buttons were cut off with no way to scroll to them. It now uses
  `overflow-x-auto` and scrolls horizontally, matching the DLQ/Jobs tables.
- **iOS Safari zoomed the page when focusing a form field.** The fluid rem type
  scale put inputs/selects/textareas under 16px on phones, which triggers
  Safari's zoom-on-focus. Controls are now pinned to 16px below the `sm`
  breakpoint (this also makes the small JSON/data editors legible on mobile).
- **The Copilot launcher covered the bottom row on scrolled pages.** The fixed
  button overlapped pagination "Next" and last-row content; the main scroll area
  now reserves bottom padding so nothing hides behind it.

### Changed
- **Mobile nav drawer is now accessible.** Opening it moves focus into the
  drawer and traps Tab within it, closing restores focus to the opener, page
  content behind the overlay no longer scrolls, and the hamburger exposes
  `aria-expanded` / `aria-controls` to assistive tech.
- **Docs prose reads naturally.** Replaced em-dash punctuation across the docs
  site with commas and plain sentences (landing, pages, known-issues, agent,
  quickstart, deploy guides).

## [0.0.25] - 2026-07-04

### Fixed
- **"Open the live demo" did nothing on the docs site.** The demo app lives on
  the same origin as the docs (different path prefix), so VitePress's SPA
  router intercepted the click and silently no-op'd. All demo links now open
  in a new tab (`target="_blank" rel="noreferrer"`), which the router leaves
  alone — and is the right behavior from docs to app anyway.

### Changed
- **UI/UX pass across every section** (from a four-auditor review of all 24
  pages; ~49 fixes). Highlights:
  - **Overview**: primary health row (Error Rate / Failed / DLQ) separated
    from secondary throughput cards; Queue Health sorts worst-first; the
    activity feed distinguishes connecting / idle / disconnected; the stale
    banner shows "last updated Xs ago".
  - **Queues**: sortable columns; queue→DLQ links keep the queue context
    (`/dlq?queue=`); Jobs and DLQ selections sync to the URL (shareable,
    back-restorable); "queue not found" links back; config cards show a
    Retry instead of vanishing on a failed fetch.
  - **Logs**: Follow/Pause with "N new" resume counter, failure reasons shown
    on failed events, job IDs linked + copyable, absolute time on hover.
  - **Alerts**: per-metric threshold units (%, ms, jobs), channel routing
    honestly marked "in-app only", queue disabled for global-only p99,
    guidance when notifications are blocked.
  - **Control**: stop/restart confirms state the blast radius (live TCP/WS
    counts); DLQ purge requires typing the queue name; Benchmark confirms the
    target queue + server before enqueuing real load; Job Inspector shows the
    error first on failed jobs, de-duplicates the Data card and puts actions
    first on mobile; Enter submits the server config and inline job actions;
    webhook URLs validated; optimistic webhook toggle.
  - **Management/shell**: honest S3 wording ("Check server storage", "Local
    draft"); Settings tests the values as typed and each token has its own
    show/hide; Database drawer is a real dialog with focus management and
    exports also toast; Copilot declares its data egress, closes on Escape
    and announces streamed replies; command palette reachable on mobile.
  - Charts gained y-scale labels and screen-reader summaries; inline action
    results announce via `role="status"`; table headers carry `scope="col"`.

## [0.0.24] - 2026-07-04

### Fixed
- **Landing page buttons/links dead on GitHub Pages.** The new landing used
  raw-HTML `href="/…"` anchors, which VitePress does not rewrite with the
  site base (`/bunqueue-dashboard/docs/`) — every internal button/card/tile
  pointed outside the site. All internal raw anchors are now relative, and
  the tour video resolves through `withBase()` (raw `src` attributes aren't
  base-rewritten either). Verified by building with the Pages base locally
  and clicking through.

## [0.0.23] - 2026-07-04

### Fixed
- **The live demo now has data on every page.** A full click-through of demo
  mode found and fixed the gaps: Workers was empty (three synthesized workers
  with now-relative last-seen, active/stale mix); DLQ entries had reason
  "unknown" and no error (now realistic timeout / max-attempts failures, and
  the per-queue reason stats match); the webhook showed 0/0 deliveries (now
  42/3 with a last-triggered time); Queue Control's Stall-detection and
  DLQ-policy cards never rendered (`/stall-config` and `/dlq-config` are now
  answered); Job Inspector logs were empty and mis-shaped (`{data:{logs}}`
  with sample lines); and the Jobs Explorer read the wrong query param
  (`state` vs the client's `states`), so status tabs did nothing and every
  queue but `emails` was empty — jobs are now filtered by the requested
  states and retagged per queue, so all four queues are browseable.

### Changed
- **Docs landing page redesigned** as a single-page product landing: keyword
  hero with a clickable window-framed screenshot that opens the live demo, an
  honest fact strip (MIT · zero-dep npm · 5-platform binaries · Docker),
  a numbered 12-card feature inventory (each linking its guide page), the tour
  video, an 8-tile "everything you can drive" grid, a 4-step get-running
  process with real UI screenshots, install tabs (npm / binary / Docker /
  source), and an 8-question FAQ with verifiable answers. Works in light and
  dark, responsive, built on VitePress theme tokens.

## [0.0.22] - 2026-07-04

### Added
- **Hook tests (23 new tests).** The four data hooks are now covered by real
  behavioral tests, rendered through a minimal in-repo hook harness
  (`test/domSetup.ts`: happy-dom document + `react-dom` root under `act()` — no
  testing-library dependency):
  - `usePolledData` — initial load, self-scheduled re-polls, render stability
    on unchanged payloads (same data reference), error set + clear on recovery,
    the generation guard dropping a stale in-flight result after a deps change,
    `refetch()`, and unmount stopping the loop.
  - `useActivityStream` — driven end-to-end through the real `sse.ts` parser
    via a mocked fetch stream: handshake → connected, newest-first ordering
    through the 150 ms flush, status/counter mapping, the 250-event ring cap,
    and the 2 s reconnect after a clean stream end.
  - `useThroughputSeries` — immediate first sample (series + `latest` + summed
    depth), swallowed transient failures; plus pure `depthTrend` cases
    (draining/accumulating/steady, dead band).
  - `useAlertEngine` — breach + single toast, edge-triggered no-re-notify, the
    skip-tick-when-overview-is-down policy (no false `<`-rule trips), per-source
    null metrics on partial failure, queue-scoped and `p99_latency` resolution,
    and the idle no-rules path (zero polling).
- `happy-dom` (dev-only) provides the DOM; the published package stays
  zero-dependency.

### Changed
- **Coverage floors raised** to lines ≥ 70% / functions ≥ 58% (from 62%/55%),
  matching the new measured totals (72.7% / 60.3%).

### Fixed
- **Release publish race.** `release.yml`'s asset globs overlapped
  (`bunqueue-dashboard-*.zip` and `bunqueue-dashboard-v*` both matched the
  zip), so the same asset was uploaded twice concurrently — the race broke the
  first v0.0.22 publish (draft left without the zip) and duplicated the zip
  line in every release's `SHA256SUMS`. The globs are now disjoint
  (`bunqueue-dashboard-v*-*` matches only the platform binaries).

## [0.0.21] - 2026-07-04

### Added
- **Unit tests for the core API client (`lib/bq.ts`).** The transport layer's
  contract is now pinned by tests: error mapping (HTTP errors, non-JSON bodies,
  empty/204 responses, invalid JSON), the HTTP-200-`{ok:false}` throw convention
  and `health()`'s opt-out, server-vs-agent auth-header scoping, the scoped
  `auth:required` event on 401, and URL/body construction for representative
  endpoints (encoding, `{limit}`/`{concurrency}` shapes, optional bodies).
- **Aggregate test-coverage floor in CI.** `bun run test:coverage` runs the
  suite with coverage and `scripts/check-coverage.ts` enforces a floor on the
  lcov totals (lines ≥ 62%, functions ≥ 55%), so overall coverage can only go
  up. (Bun's own `coverageThreshold` is applied per file, which a single
  legitimately low-coverage module would fail regardless of the aggregate.)

### Changed
- **`/cron-manager` now redirects to `/cron`.** The two routes served the same
  `CronManager` page; the alias is kept as a redirect so old bookmarks keep
  working.
- **Docs caught up with the shipped app.** `CLAUDE.md`'s layout and
  `docs/pages.md`'s route/page tables now document every routed page —
  Benchmark, Flows, MCP guide, QueuesOverview, QueueDetailPro, Bulk Add, the
  demo-mode fetch shim, the Copilot assistant, the client-side alert engine —
  and no longer claim Alerts is unrouted.

## [0.0.20] - 2026-07-03

### Changed
- **DLQ Control redesign.** The single-queue DLQ page is now a proper triage
  surface: a 4-card summary (entries + top failure reason, distinct failure
  types, pending auto-retries, oldest entry age), a page-scoped reason filter and
  job-ID search, clickable + copyable job IDs, one-click CSV export, toast
  feedback on retry/purge, and **expandable rows** that reveal each entry's full
  error and per-attempt failure history. (Distinct from the cross-queue `/dlq`
  dashboard, which stays the fleet-wide view.)

## [0.0.19] - 2026-07-03

### Added
- **Pro queue drill-in.** Clicking a queue in the Overview / Queues list now opens
  a route-param-driven Pro page (`/queues/:name` → `QueueDetailPro`) with live
  counts, a backlog-depth sparkline + draining/accumulating trend, the full
  lifecycle/limits/stall/DLQ-policy controls (reused from Queue Control),
  **obliterate**, recent jobs, and jump-off links to the queue's Jobs and DLQ.
  The classic detail page stays reachable at `/queues-classic/:name`.
- **Global toast system.** A durable, cross-page action-feedback surface
  (`toastStore` + `<Toaster/>` mounted in the layout). Mutating actions across the
  Pro pages now raise a toast that survives navigation (a fire-and-leave bulk
  action is still confirmed after you move on), alongside the existing inline
  feedback.
- **Threshold alerting + desktop notifications.** The previously-unreachable
  **Alerts** page is now routed and in the nav, and a client-side engine
  (`useAlertEngine`, mounted app-wide) evaluates the enabled rules against live
  metrics, raising an in-app toast and — once you opt in — a browser
  desktop notification on each fresh threshold crossing (edge-triggered, with a
  per-rule cooldown). Delivery channels (email/webhook/slack) still need your own
  backend; the browser evaluation runs while any tab is open.
- **Bulk-import distinct jobs.** A new **Bulk Add** page (`/jobs/bulk-add`) imports
  many *different* jobs at once from a pasted JSON array, NDJSON, or an uploaded
  file (Add Job's Count field only replicates one identical payload).
- **Clone a job.** The Job Inspector can now open Add Job pre-filled from an
  existing job's queue/data/options, to tweak and enqueue a fresh job without
  disturbing the original.
- **Schedule at an absolute time.** Add Job gained a **Run at** datetime picker that
  derives the delay, so you no longer hand-compute milliseconds.
- **Copy / download job JSON.** The Job Inspector's Data and Result cards have
  copy + download controls, plus a header **Download JSON** for the full record
  (job + result).
- **CSV export** on the Jobs Explorer and Dead Letter Queue pages (current page,
  respecting the active filters).
- **Cross-queue DLQ recovery.** The DLQ page can retry or purge across *every*
  affected queue in one action (incident recovery), tolerating per-queue failures.
- **Pause all / Resume all queues** from the Queues page header — the first reflex
  during an incident or deploy.
- **Cron advanced options + next-run preview.** The Cron create form now exposes
  timezone, priority, prevent-overlap and skip-if-no-worker, and shows a live
  preview of the next fire times (with client-side expression validation) so a
  mistyped schedule is caught before it's created.

## [0.0.18] - 2026-07-03

### Fixed
- **Docs:** clarified the agent's Host-allowlist note — `BIND_ADDR` disables the
  DNS-rebinding Host check only on the **standalone binary** (`scripts/serve.ts`);
  the plain `bun run agent` always binds `127.0.0.1` with the gate on, so
  `AGENT_ALLOWED_HOSTS` is its only lever.

## [0.0.17] - 2026-07-03

### Security
- **`AGENT_TOKEN` is now wired end-to-end (was a functional dead-end).** The
  browser agent client (`bq.ts` `agent()`) never sent a token, so a control
  agent started with `AGENT_TOKEN` set rejected every start/stop/restart/config
  call with 401 — and `bq.ts`'s 401 handler popped the **server** token prompt,
  which can never satisfy an **agent** 401 (an unfixable loop). Now the agent
  client sends the agent token, the `auth:required` event is **scoped**
  (`server` vs `agent`) so the lock screen asks for the right one, and there's
  an **Agent token** field in Settings (memory-only, or `VITE_BUNQUEUE_AGENT_TOKEN`).
- **DNS-rebinding read exposure closed on the control agent.** The Origin
  allowlist doesn't cover a *same-origin* request, so a page whose DNS was
  rebound to `127.0.0.1` could read `/control/status`, `/control/logs` and the
  `/db/*` inspector (job payloads) over Origin-less GETs — even with
  `AGENT_TOKEN` set (the token exempts reads). The agent now enforces a
  **Host-header allowlist** (loopback + `AGENT_ALLOWED_HOSTS`); an attacker
  domain rebound to loopback fails it. The standalone binary applies the same
  gate across `/api`, `/agent` and assets when bound to loopback (a non-loopback
  `BIND_ADDR` is unchanged — that's an explicit LAN opt-in).
- **Alert channel secrets no longer persisted in plaintext.** `alertsStore` had
  no `partialize`, so `webhook`/`slack` channel targets (secret URLs) were
  written to `localStorage`. They're now kept in memory only (email targets,
  not credentials, still persist), matching the connection-token / S3-key policy.

### Fixed
- **Benchmark "Clean queue" no longer reports a false success.** With the server
  unreachable, the verification `counts()` failed silently and the UI showed a
  green "Cleaned — 0 jobs remain" having cleaned nothing. It now surfaces
  "Clean unverified — <error>" when the verifying read fails.
- **Copilot error messages: a rate-limit/overload error that mentions the model
  id is no longer mislabeled as "invalid model id".** `friendly()` classified
  any message containing "model" as a bad model; rate-limit/overload is now
  matched first and the model-error branch only fires on genuine not-found/
  invalid-model signals.
- **Blue `StatCard` values now meet contrast on the light theme** (`light:` shade
  override, matching `StatusBadge`).
- **Demo mode now renders Server Control.** The GitHub Pages demo faked no
  `/control/*` endpoint, so ServerControl got a bare `{ ok: true }`; it now
  returns a coherent running-server snapshot (status / logs / config).

### Changed
- **`agent/` and `scripts/` are now typechecked** by the build gate
  (`tsconfig.agent.json`, `bun-types`) — the shipped npm bin (`serve.ts`) and
  the security-sensitive agent code previously passed the gate with no
  typecheck. This surfaced and fixed four latent type errors (Bun subprocess
  stream casts, a readonly-tuple spawn arg, a `URL`→`Request` construction). The
  Biome exclusion of those dirs is unchanged (lint/format style, not types).

## [0.0.16] - 2026-07-03

### Fixed
- **Server Control now works with a custom `AGENT_PORT` (npm package /
  standalone binaries) — and from a remote browser.** The SPA's agent URL was
  baked at build time (`VITE_BUNQUEUE_AGENT_URL`, default `localhost:6800`),
  so overriding `AGENT_PORT` left the Server page on "Control agent
  unreachable", and a remote browser could never reach the loopback-only
  agent at all. The all-in-one server now bridges the agent **same-origin at
  `/agent/*`** (in-process, no loopback hop) and injects
  `window.__BUNQUEUE_AGENT_URL__ = '/agent'` into the served index.html;
  `lib/bq.ts` reads the runtime value before the baked-in one. The agent's
  Origin allowlist and optional `AGENT_TOKEN` still apply unchanged — this
  changes reachability, not authorization: for remote (non-localhost) access
  you must still opt the browser-facing origin in via
  `AGENT_ALLOWED_ORIGINS=http://myhost:8080`. Dev (`bun start`) is untouched.

## [0.0.15] - 2026-07-03

### Changed
- **Zero-dependency npm package.** `agent/logger.ts` is now a dependency-free
  console logger with the same pino call signature and NDJSON output shape
  (numeric `level`, `time`, merged fields, an `Error` first-arg lifted to
  `err.message`/`err.stack`) plus colorized pretty lines on a TTY — pino and
  pino-pretty were the package's only runtime dependencies, so
  `bunx bunqueue-dashboard` now installs the dashboard tarball and nothing
  else (29 packages / ~5.2 MB → 1 package / ~1.8 MB on disk).
- **Slimmer assets: latin + latin-ext font subsets only.** The fontsource
  index imports pulled cyrillic/greek/vietnamese woff2 the UI never renders;
  a hand-picked `src/fonts.css` keeps the same font-family names and
  unicode-ranges with 4 files instead of 12. Together with dropping
  CHANGELOG.md from the tarball, the npm package goes 667 kB → 543 kB
  (1.7 MB → 1.6 MB unpacked). Non-latin text falls back to the system font.
- **Docs now cover the npm package.** Quickstart, docs home, Deployment, and
  PM2 all lead with `bunx bunqueue-dashboard` (env knobs, global install,
  PM2 interpreter line); the PM2 release-download example no longer hardcodes
  a stale tag.

## [0.0.14] - 2026-07-03

### Added
- **npm package: `bunx bunqueue-dashboard`.** The dashboard is now publishable
  to npm as a Bun-first CLI: one command serves the prebuilt SPA, proxies
  `/api/*` to the bunqueue server, and runs the control agent — the same
  `scripts/serve.ts` the standalone binaries compile, running uncompiled
  (verified: SPA, history fallback, proxy, and agent all answer from a tarball
  install). The tarball ships `dist/` + the agent + the embed manifest only;
  runtime dependencies are down to `pino`/`pino-pretty` (the UI libraries are
  build-time and moved to devDependencies). `release.yml` gains an idempotent
  `npm` job: it publishes with `--provenance` iff the `NPM_TOKEN` secret is set
  and the version isn't already on the registry — a missing secret or an
  un-bumped version is a clean skip, never a failure.

## [0.0.13] - 2026-07-03

### Fixed
- **A page opened in a background tab no longer sits on "Loading…" forever.**
  `usePolledData` paused polling while the tab was hidden — including the very
  first fetch, so a cmd-clicked tab showed a permanent spinner (and the sidebar
  a permanent "connecting") until focused. The first fetch now always runs;
  only the recurring refreshes pause with the Page Visibility API.
- **Overview / Metrics / Usage / Jobs no longer report 0 completed jobs after a
  server restart.** Their Completed / Failed cards and error rates read the
  `totalCompleted`/`totalFailed` session counters (zeroed on every restart,
  labeled "all time") while the queues visibly held thousands of completed
  jobs. They now read the recorded counts (`stats.completed` + per-queue failed
  sums from `/queues/summary`); the counters that really are per-session
  (pushed/pulled) are now labeled "since restart", and Diagnostics' "Lifetime
  totals" card is renamed "Totals since restart".
- **"100.00% success rate" is no longer claimed over zero processed jobs.**
  Error/success rates render an em dash until at least one job has completed
  or failed (`errorRate` now returns `null` for an empty denominator).
- **Jobs Explorer stat cards no longer flash hard zeros while loading** — they
  show placeholders until the overview poll arrives, and the Total card is
  labeled "all queues" so the global numbers aren't read as the selected
  queue's.
- **Process logs (Server page) no longer show raw ANSI escape codes** — the
  bunqueue banner's `[1m…[0m` color noise is stripped from display, search,
  copy, and download (new `stripAnsi` in `lib/format.ts`).
- **Environment-variable rows (Server page) get a usable value field.** The
  KEY input swallowed the whole row and the value input collapsed to a sliver:
  `Input` always carries `w-full` and `cn()` does no Tailwind conflict
  resolution, so the `w-2/5`/`flex-1` passed by the editor lost to it. Widths
  now live on wrapper divs.

### Changed
- **Dead Letter Queue auto-selects the biggest non-empty queue** on first load
  (like DLQ Control) instead of parking on a "Select a queue" prompt.
- **Flows remembers the flows you've viewed** (locally, up to 8) and offers
  them as one-click chips in the empty state — bunqueue has no "list flows"
  endpoint, so this replaces a dead end with a way back in.

## [0.0.12] - 2026-07-03

### Added
- **Animated product tour.** A roughly 50-second guided tour on the README (an
  optimized GIF) and on the docs home (an autoplaying, muted, looping MP4, a far
  lighter video so it does not slow the home page), clicking through the
  overview, queues, jobs, the dead-letter queue, flows, the SQLite inspector,
  and the AI Copilot.

## [0.0.11] - 2026-07-03

### Added
- **Copilot (experimental): an in-dashboard AI assistant.** A chat panel (the
  button in the bottom right) that reads your live queue state and can propose
  actions you confirm before they run. Bring your own model via the Vercel AI
  SDK: Claude (Anthropic), ChatGPT (OpenAI), Gemini (Google), GLM (Z.ai),
  OpenRouter (one key for every model), or any OpenAI-compatible endpoint
  (Groq, Together, a local Ollama or LM Studio). Your API key stays in memory
  for the session only and is never written to disk; the provider and model are
  remembered. Read tools (queues, jobs, DLQ, workers, crons, health) run
  immediately; mutating tools (retry, promote, remove, pause/resume, retry/purge
  DLQ) are gated behind an explicit in-chat confirmation. The whole panel plus
  the AI SDK (~165 KB gz) is lazy-loaded, so it adds nothing to the initial
  bundle. New `docs/guide/copilot` page.

### Changed
- **Bundle budget now measures the INITIAL load, not every chunk.** The
  `bun run size` gate reads Vite's build manifest and sums the entry chunk plus
  its static imports (currently ~91 KB gz, budget 230 KB), so lazily-loaded
  features (the demo shim, the Copilot) no longer count against it. A separate,
  generous cap on the grand total still guards against a runaway dependency.

## [0.0.10] - 2026-07-03

### Added
- **Flows: an interactive job-flow DAG.** A new page that draws a job flow as a
  graph, parent to children (solid edges) and dependency edges (dashed), with
  every node coloured by state. Paste any job ID (or use the new **View flow**
  link in the Job Inspector); the page climbs `parentId` to the flow's root, then
  walks `childrenIds` and `dependsOn` client-side (bunqueue has no single
  "get whole flow" endpoint), lays it out with a pure, unit-tested layered-layout
  engine, and lets you click any node to inspect it. 100% frontend, no graph
  library. Demo mode ships a sample flow so the page is populated out of the box.
  New "Flows" nav item (Queues) and a `docs/guide/flows` page.

### Changed
- **Full-width pages.** Add Job and Settings now fill the content width with a
  two-column layout instead of a narrow centred column, and the Job Inspector
  lookup bar spans the width.

### Fixed
- **Classic DLQ page no longer crashes.** It rendered the job's `attempts` field
  directly, but the verified DLQ-entry shape makes `attempts` an array, so React
  threw "Objects are not valid as a React child" (a white screen) against both a
  real server and the demo. It now shows the attempt count, and the row key no
  longer relies on a missing `id`.
- **Job Inspector custom-ID lookup.** A `200` with no `job` (a custom id that
  resolves to nothing) is now treated as "not found" instead of throwing
  `Cannot read properties of undefined (reading 'state')`. Demo mode also answers
  `GET /jobs/custom/:id`, so custom-id lookups work there too.

## [0.0.9] - 2026-07-03

### Added
- **MCP Server page + docs.** A setup and reference for bunqueue's Model Context
  Protocol server (`bunqueue-mcp`), which lets AI agents (Claude Desktop, Claude
  Code) drive the queue. Copy-able configs for both connection modes (embedded
  via `DATA_PATH`, and TCP via `BUNQUEUE_MODE`/`HOST`/`PORT`/`TOKEN`), plus the
  full capability inventory: 73 tools across 12 categories, 5 resources, and 3
  prompts. New "MCP" item in the Management nav and a `docs/guide/mcp` page.
  Because `bunqueue-mcp` is a separate stdio process launched by the MCP client,
  the page is a guide, not a live monitor.

## [0.0.8] - 2026-07-03

### Added
- **SEO: JSON-LD structured data** (schema.org) on every docs page, a
  `SoftwareApplication` node on the home and a `TechArticle` + `BreadcrumbList`
  on each content page, all linked to a shared `WebSite` + `Person` graph, so the
  docs are eligible for rich results. Plus `og:locale`, `og:image:alt` /
  `twitter:image:alt`, and explicit `robots` directives (`index, follow,
  max-image-preview:large, max-snippet:-1`).
- **Enterprise, fluid docs typography.** The docs now use the same variable fonts
  as the app (Inter for text, JetBrains Mono for code), self-hosted with no CDN,
  and a fluid (viewport-scaled) type scale for headings and body copy, with
  optical sizing, Inter stylistic sets, and tabular figures in code and tables.

### Fixed
- **Demo mode: the Database page no longer crashes** (`Cannot read properties of
  undefined (reading 'toUpperCase')`). The SQLite inspector's `/db/*` endpoints
  now return proper demo fixtures (info, table list, per-table schema and rows,
  and a read-only query result), so the inspector is fully explorable in the demo
  instead of erroring.
- **Demo mode:** `GET /queues/:q/dlq/stats` now returns a stats-shaped body (it
  was mis-routed to the DLQ-entries fixture, leaving the demo DLQ stat cards
  empty), and the base/`/api` path stripping is anchored to a segment boundary so
  a path like `/apihealth` can't be mis-stripped.

## [0.0.7] - 2026-07-03

### Added
- **Demo mode.** A bundled fetch/SSE shim answers every bunqueue API call from a
  fixture captured from a real bunqueue 2.8.26 server, so the whole dashboard is
  explorable with no backend: queues, jobs, DLQ, cron, webhooks, and a live
  activity feed that actually animates. A "Live demo" badge marks it. The demo
  code and its fixture load lazily, so they add nothing to the normal bundle.
- **Live demo hosting.** The GitHub Pages app now ships in demo mode, so
  `https://egeominotti.github.io/bunqueue-dashboard/` is a fully clickable live
  demo. Linked from the README, the docs home, and the Quickstart.

### Changed
- The GitHub Pages build serves the root app in demo mode (`VITE_DEMO=1`) instead
  of an empty "point it at your server" shell. To drive a real server, build your
  own (Docker / the standalone binary) without `VITE_DEMO`.

## [0.0.6] - 2026-07-03

### Added
- **Token lock screen.** When the bunqueue server runs with `AUTH_TOKENS` and a
  request comes back `401`, a lock overlay prompts for the bearer token, stores
  it for the session (never persisted to disk, same as before), and dismisses. If
  the token is still rejected, the next poll re-locks. Includes an "Open Settings
  instead" escape. To wire it up, `bq.ts` now emits an `auth:required` event on a
  `401` (and still throws), so the UI can prompt for credentials.

## [0.0.5] - 2026-07-03

### Added
- **Quickstart.** A dedicated Quickstart page (prerequisites, install, one-command
  run, connecting a server, and next steps), linked from the docs nav and the
  "Getting started" sidebar group, plus a prominent "Quick start" hero action and
  section on the docs home.

## [0.0.4] - 2026-07-03

### Added
- **Lighthouse CI** on pull requests: performance, accessibility, best-practices,
  and SEO budgets for the built SPA, with the report uploaded to temporary public
  storage. Thresholds are advisory (`warn`) for now; promote to `error` to
  enforce.

### Fixed
- **Pages deploy timeout** set to the `deploy-pages` action's real maximum
  (600000 ms; the previous 900000 was clamped by GitHub with a warning).
  Documented that a "Deployment failed, try again later" is a transient
  Pages-backend error to re-run, not a config problem.

## [0.0.3] - 2026-07-03

### Added
- **Command palette (Cmd/Ctrl-K).** Fuzzy-search every page plus a few actions
  (toggle theme, open docs) and jump there, fully keyboard-driven (↑/↓, ↵, esc),
  with an accessible backdrop and a Topbar search trigger. Its command list is
  sourced from the sidebar nav, so new sections appear automatically.
- **Bundle-size budget** (`bun run size`), enforced in CI: fails the build if the
  total gzipped JavaScript exceeds 230 KB (currently ~162 KB), so a careless
  dependency can't silently bloat the app.

## [0.0.2] - 2026-07-03

### Added
- **Structured logging with pino + pino-pretty** for the control agent and the
  standalone server (replaces plain `console.log`): pretty and colorized on a
  terminal, newline-delimited JSON in production, level via `LOG_LEVEL`.
- **Accessibility:** a "Skip to content" link (bypasses the nav for keyboard and
  screen-reader users) and full `prefers-reduced-motion` support.
- **Community-health files:** `SECURITY.md`, `CONTRIBUTING.md`,
  `CODE_OF_CONDUCT.md`, and bug-report / feature-request issue templates.
- **CI hardening:** a dependency audit (`bun audit`) and test coverage on every
  run, plus a **CodeQL** SAST workflow.
- **Supply-chain integrity:** release binaries now ship a `SHA256SUMS` file and a
  signed **build-provenance attestation**; the Docker image gets an **SBOM** and
  a signed provenance attestation (verifiable with `gh attestation verify`).
- **Full truth-table test** for `jobActions.actionGates` (the job-action gating
  source of truth).
- **README hero screenshot** and a screenshot gallery.

### Changed
- **The standalone server binds `127.0.0.1` by default** (`BIND_ADDR=0.0.0.0` to
  expose): the `/api` proxy to bunqueue's admin API is no longer reachable from
  the whole network out of the box.
- **Dark-theme accent darkened to `#db2777`** so white text on accent buttons and
  badges meets WCAG AA contrast (was 3.5:1).

### Fixed
- Declared `VITE_BUNQUEUE_AGENT_URL` in the env type definitions (was read
  untyped).

## [0.0.1] - 2026-07-02

First tagged release. A web dashboard that fully drives a bunqueue server over
its public HTTP API plus a small local control agent, with an illustrated
documentation site.

### Added
- **Full control surface.** View and drive queues, jobs, the dead-letter queue,
  cron, webhooks, and workers. Every job action is gated by the job's real
  current state (`src/lib/jobActions.ts`) so the UI never offers something the
  server would reject.
- **Live, not just polled.** Cheap polling plus a Server-Sent-Events stream for
  real-time job activity, with automatic reconnect and rolling throughput,
  latency, and queue-depth charts.
- **Process lifecycle.** A small local control agent (loopback-bound,
  CORS-locked to an allowlist, optional `AGENT_TOKEN`) starts, stops, and
  restarts the bunqueue process with live logs.
- **Read-only SQLite inspector** (`/database`): browse tables, schema and
  indexes, page through rows, and run statement-allowlisted, row-capped,
  read-only queries with `EXPLAIN` and CSV/JSON export.
- **Two API clients by design:** the original `src/lib/api.ts` behind the
  first-generation classic pages, and the complete, shape-verified,
  strict-error-checked `src/lib/bq.ts` behind every Pro control page.
- **Illustrated documentation site** (VitePress, published to GitHub Pages under
  `/docs/`): a user-first, screenshot-backed page per dashboard section, a
  Mermaid data-flow diagram, local search, and auto-generated
  `llms.txt` / `llms-full.txt`.
- **Deployment guides:** Docker (Caddy), Kubernetes, PM2, and hosting-platform
  recipes (Vercel, Netlify, Cloudflare Pages, GitHub Pages, Render, Fly.io,
  Railway, Google Cloud Run), plus an overview of the two deployment modes.
- **SEO on the docs:** `sitemap.xml`, `robots.txt`, per-page canonical links and
  meta descriptions, and Open Graph / Twitter cards.
- **Docker image** served with Caddy (gzip + zstd, SPA history fallback,
  immutable asset caching), published to the GitHub Container Registry.
- **CI/CD:** the lint + build + test gate on every push and PR, GitHub Pages
  deploy, multi-arch Docker image, and a Release workflow that cross-compiles
  standalone executables for 5 platforms (the all-in-one SPA + `/api` proxy +
  control agent in one binary).
- **Custom brand:** a queue-badge logo and favicon, and hand-drawn monoline
  feature icons on the docs home.

[Unreleased]: https://github.com/egeominotti/bunqueue-dashboard/compare/v0.0.31...HEAD
[0.0.31]: https://github.com/egeominotti/bunqueue-dashboard/compare/v0.0.30...v0.0.31
[0.0.30]: https://github.com/egeominotti/bunqueue-dashboard/compare/v0.0.29...v0.0.30
[0.0.29]: https://github.com/egeominotti/bunqueue-dashboard/compare/v0.0.28...v0.0.29
[0.0.28]: https://github.com/egeominotti/bunqueue-dashboard/compare/v0.0.27...v0.0.28
[0.0.27]: https://github.com/egeominotti/bunqueue-dashboard/compare/v0.0.26...v0.0.27
[0.0.26]: https://github.com/egeominotti/bunqueue-dashboard/compare/v0.0.25...v0.0.26
[0.0.25]: https://github.com/egeominotti/bunqueue-dashboard/compare/v0.0.24...v0.0.25
[0.0.24]: https://github.com/egeominotti/bunqueue-dashboard/compare/v0.0.23...v0.0.24
[0.0.23]: https://github.com/egeominotti/bunqueue-dashboard/compare/v0.0.22...v0.0.23
[0.0.22]: https://github.com/egeominotti/bunqueue-dashboard/compare/v0.0.21...v0.0.22
[0.0.21]: https://github.com/egeominotti/bunqueue-dashboard/compare/v0.0.20...v0.0.21
[0.0.20]: https://github.com/egeominotti/bunqueue-dashboard/compare/v0.0.19...v0.0.20
[0.0.19]: https://github.com/egeominotti/bunqueue-dashboard/compare/v0.0.18...v0.0.19
[0.0.18]: https://github.com/egeominotti/bunqueue-dashboard/compare/v0.0.17...v0.0.18
[0.0.17]: https://github.com/egeominotti/bunqueue-dashboard/compare/v0.0.16...v0.0.17
[0.0.16]: https://github.com/egeominotti/bunqueue-dashboard/compare/v0.0.15...v0.0.16
[0.0.15]: https://github.com/egeominotti/bunqueue-dashboard/compare/v0.0.14...v0.0.15
[0.0.14]: https://github.com/egeominotti/bunqueue-dashboard/compare/v0.0.13...v0.0.14
[0.0.13]: https://github.com/egeominotti/bunqueue-dashboard/compare/v0.0.12...v0.0.13
[0.0.12]: https://github.com/egeominotti/bunqueue-dashboard/compare/v0.0.11...v0.0.12
[0.0.11]: https://github.com/egeominotti/bunqueue-dashboard/compare/v0.0.10...v0.0.11
[0.0.10]: https://github.com/egeominotti/bunqueue-dashboard/compare/v0.0.9...v0.0.10
[0.0.9]: https://github.com/egeominotti/bunqueue-dashboard/compare/v0.0.8...v0.0.9
[0.0.8]: https://github.com/egeominotti/bunqueue-dashboard/compare/v0.0.7...v0.0.8
[0.0.7]: https://github.com/egeominotti/bunqueue-dashboard/compare/v0.0.6...v0.0.7
[0.0.6]: https://github.com/egeominotti/bunqueue-dashboard/compare/v0.0.5...v0.0.6
[0.0.5]: https://github.com/egeominotti/bunqueue-dashboard/compare/v0.0.4...v0.0.5
[0.0.4]: https://github.com/egeominotti/bunqueue-dashboard/compare/v0.0.3...v0.0.4
[0.0.3]: https://github.com/egeominotti/bunqueue-dashboard/compare/v0.0.2...v0.0.3
[0.0.2]: https://github.com/egeominotti/bunqueue-dashboard/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/egeominotti/bunqueue-dashboard/releases/tag/v0.0.1
