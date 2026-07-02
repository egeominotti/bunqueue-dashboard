# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows the auto-versioning scheme in `.github/workflows/release.yml`
(decimal rollover: patch 0–9, then the minor increments — `v0.1.9 → v0.2.0`).

**Process (see `CLAUDE.md`):** before every push to `main`, record changes under
`## [Unreleased]`. For every version, rename `[Unreleased]` to the version being
released and start a fresh empty `[Unreleased]`. The release workflow publishes the
matching version section (or `[Unreleased]`) as the GitHub Release body.

## [Unreleased]

### Added
- **VitePress documentation site**, published to GitHub Pages under `/docs/`
  alongside the app (the app stays at the site root). Built from the existing
  `docs/*.md` as the single source of truth via `scripts`-free
  `vitepress build docs`; deployed by `pages.yml` (`DOCS_BASE` = the Pages
  sub-path). New `bun run docs:dev` / `docs:build` / `docs:preview` scripts.
- **Per-section user guide.** The monolithic guide is split into one detailed,
  source-grounded page per dashboard section under `docs/guide/*`, grouped in the
  sidebar exactly like the dashboard (Home · Queues · Monitoring · Control ·
  Management) plus a Classic-pages appendix. Each page documents every field,
  action, state/gating rule, the API calls behind it, and its gotchas.
- **Modern docs features:** a Mermaid data-flow diagram in `architecture.md`,
  Shiki Twoslash-ready code blocks, cross-page View Transitions, local search,
  and auto-generated `llms.txt` / `llms-full.txt` for LLM consumption.
- **Custom brand + iconography:** a new queue-badge logo/favicon (replacing the
  bunny) and six hand-drawn monoline feature icons on the docs home.

## [0.2.3] - 2026-07-02

### Added
- **Illustrated user guide** (`docs/user-guide.md`): every routed page documented
  with a real screenshot (`docs/screenshots/`, captured against a live seeded
  server) and an explanation of what it shows, the actions it offers, and its
  known gotchas — Pro pages, classic pages, and the 404 catch-all.

## [0.2.2] - 2026-07-02

### Fixed
- Changelog version headings now match the tags `release.yml` auto-creates (this
  project was already at `v0.2.x`, not `v0.1.0`), so each release's notes are
  sourced from its own `CHANGELOG.md` section instead of falling back to the
  generated commit list.

## [0.2.1] - 2026-07-02

Enterprise SQLite inspector, a full UI/UX pass across every section, and a large
stability sweep.

### Added
- **Database inspector** (`/database`): read-only SQLite browser served by the
  control agent — sortable/paginated data grid with column type + PK header
  badges, per-row detail drawer (full untruncated values via a rowid cell fetch,
  JSON pretty-print, per-value copy), inline column filter, schema tab
  (columns/indexes/DDL), store metadata cards, and a query runner with history,
  `EXPLAIN`, and CSV/JSON export. Every connection is opened read-only; an
  arbitrary query is statement-allowlisted, row-capped, and time-boxed in a
  disposable worker (synchronous fallback in compiled binaries).
- **Pro pages** `UsagePro` and `WorkersPro`; `/cron` now serves the full Cron
  Manager. Classic first-generation pages remain reachable at `*-classic`.
- **`CHANGELOG.md`** is now the source of GitHub Release notes: `release.yml`
  publishes the released version's section (falling back to `[Unreleased]`, then
  to auto-generated notes).
- App-wide `ErrorBoundary`, semantic theme-aware status colors, and a mobile nav
  drawer.

### Changed
- Full UI/UX pass across every section: standardized success/error feedback,
  destructive confirmations that name their target and count, honest empty
  states, accessible form labels and focus rings, and WCAG-compliant contrast in
  the light theme.
- Server page surfaces live RAM and connection counts; `scripts/dev.ts` spawns
  services directly so `Ctrl-C` reaches them (no orphaned processes).
- `docker.yml` / `pages.yml` now run the full gate (lint · build · test) before
  publishing.

### Fixed
- 20 adversarially-verified stability fixes across the shared lib, Pro pages, the
  control agent, and infra (event-order under StrictMode, duration formatting,
  stale-view races on queue/filter switches, agent SIGINT/SIGTERM cleanup, log
  pipe flush, `react-router` vendor chunking, standalone-binary `/api` proxy
  content-encoding, and more).
- Segment-based `/db/tables` routing so tables literally named `schema` or `cell`
  resolve correctly.

[Unreleased]: https://github.com/egeominotti/bunqueue-dashboard/compare/v0.2.3...HEAD
[0.2.3]: https://github.com/egeominotti/bunqueue-dashboard/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/egeominotti/bunqueue-dashboard/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/egeominotti/bunqueue-dashboard/compare/v0.2.0...v0.2.1
