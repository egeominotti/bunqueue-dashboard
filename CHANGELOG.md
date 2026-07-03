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

[Unreleased]: https://github.com/egeominotti/bunqueue-dashboard/compare/v0.0.15...HEAD
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
