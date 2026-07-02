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

## [0.1.0] - 2026-07-02

First tagged release. The dashboard fully drives a bunqueue server over its public
HTTP API plus a local control agent, with a Pro page set and a read-only SQLite
inspector.

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
- **Standalone executables** for 5 platforms and a continuous-delivery release
  pipeline (this changelog now backs the release notes).
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

[Unreleased]: https://github.com/egeominotti/bunqueue-dashboard/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/egeominotti/bunqueue-dashboard/releases/tag/v0.1.0
