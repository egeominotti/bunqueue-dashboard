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

[Unreleased]: https://github.com/egeominotti/bunqueue-dashboard/compare/v0.0.8...HEAD
[0.0.8]: https://github.com/egeominotti/bunqueue-dashboard/compare/v0.0.7...v0.0.8
[0.0.7]: https://github.com/egeominotti/bunqueue-dashboard/compare/v0.0.6...v0.0.7
[0.0.6]: https://github.com/egeominotti/bunqueue-dashboard/compare/v0.0.5...v0.0.6
[0.0.5]: https://github.com/egeominotti/bunqueue-dashboard/compare/v0.0.4...v0.0.5
[0.0.4]: https://github.com/egeominotti/bunqueue-dashboard/compare/v0.0.3...v0.0.4
[0.0.3]: https://github.com/egeominotti/bunqueue-dashboard/compare/v0.0.2...v0.0.3
[0.0.2]: https://github.com/egeominotti/bunqueue-dashboard/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/egeominotti/bunqueue-dashboard/releases/tag/v0.0.1
