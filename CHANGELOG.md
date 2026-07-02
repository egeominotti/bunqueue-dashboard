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

[Unreleased]: https://github.com/egeominotti/bunqueue-dashboard/compare/v0.0.4...HEAD
[0.0.4]: https://github.com/egeominotti/bunqueue-dashboard/compare/v0.0.3...v0.0.4
[0.0.3]: https://github.com/egeominotti/bunqueue-dashboard/compare/v0.0.2...v0.0.3
[0.0.2]: https://github.com/egeominotti/bunqueue-dashboard/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/egeominotti/bunqueue-dashboard/releases/tag/v0.0.1
