# bunqueue-dashboard — project instructions

A web dashboard that **fully drives** a bunqueue server: view + control queues,
jobs, DLQ, cron, webhooks, workers, live activity, and the server **process
lifecycle** (start / stop / restart).

It talks only to bunqueue's public HTTP API (`:6790`) plus a small local
**control agent** that manages the server process. It never imports or modifies
bunqueue source.

## Golden rule: additive only

**Never rewrite or break existing files.** Build new capabilities as **new files**
and connect them with minimal glue (a route in `src/App.tsx`, a nav item in
`src/components/layout/Sidebar.tsx`). Two API layers coexist on purpose:

- `src/lib/api.ts` — the original client used by the first-generation view pages.
- `src/lib/bq.ts` — the complete, shape-verified client used by every `pages/control/*`
  page and the agent. **New work uses `bq`.**

Do not "fix" old pages in place; add a corrected new page and route to it.

## Stack

React 19 · React Router 7 · Zustand 5 · Vite 8 · Tailwind CSS v4 · Biome · Bun · TypeScript.

## Layout

```
bunqueue-dashboard/
├── .github/
│   ├── workflows/             # ci.yml · pages.yml · docker.yml · release.yml (see “CI/CD” below)
│   ├── dependabot.yml         # weekly npm / actions / docker bumps
│   └── pull_request_template.md
├── agent/                     # Bun control agent (process lifecycle) — NOT linted/typechecked with src
│   ├── manager.ts             # ProcessManager: spawn/kill bunqueue, log ring buffer, dbStats()
│   ├── db.ts                  # read-only SQLite inspector: tables/schema/rows/query (readonly conn, unit-tested)
│   ├── server.ts              # fetch handler + origin/CORS/token policy (unit-tested)
│   └── index.ts               # binds 127.0.0.1; Origin allowlist + locked CORS + optional AGENT_TOKEN;
│                               # SIGINT/SIGTERM stop the managed server (no orphans)
├── docker/nginx.conf          # SPA history fallback + gzip + immutable asset caching for the image
├── scripts/dev.ts             # one-command dev launcher (`bun start`) — NOT linted/typechecked with src
├── Dockerfile                 # multi-stage: Bun build → nginx serve
├── src/
│   ├── lib/                   # api.ts, bq.ts, bqTypes.ts, types.ts, jobActions.ts, sse.ts, format.ts, cn.ts,
│   │                           # usePolledData.ts, useActivityStream.ts, useThroughputSeries.ts
│   ├── components/
│   │   ├── layout/            # Sidebar, Topbar, AppLayout, SidebarFooter
│   │   ├── ui/                # StatCard, StatusBadge, Card, Button, CopyButton, form, feedback, PageHeader, AreaChart, icons
│   │   └── dashboard/stores/  # Zustand: theme, connection, alerts, s3
│   ├── pages/                 # first-gen view pages (Overview, Queues, QueueDetail, Jobs, Dlq, Cron, Metrics, Workers,
│   │   │                       # Logs, Usage, S3Backup, Settings, Alerts [unrouted — see docs/pages.md], NotFound)
│   │   ├── queue/              # QueueConfig (used by classic QueueDetail)
│   │   └── control/           # Pro pages: OverviewPro, ServerControl, AddJob, JobInspector, JobsPro, DlqPro,
│   │       │                   # DlqControl, MetricsPro, LogsPro, QueueControl, CronManager, Webhooks,
│   │       │                   # Diagnostics, S3BackupPro, Database (SQLite inspector), UsagePro, WorkersPro
│   │       ├── job/            # JobInspector subcomponents: JobTimeline, JobBackoff
│   │       └── queue/          # QueueControl subcomponents: QueueActions, ConfigForms
│   ├── App.tsx                # routes — see docs/pages.md for the verified route→page table
│   └── main.tsx                # entry (fonts, theme, router; basename = import.meta.env.BASE_URL for Pages)
├── test/                      # bun test (format, sse, manager, agent lifecycle, s3 store)
└── docs/                      # how it works — see docs/README.md; docs/known-issues.md tracks verified gaps
```

## Run

```bash
bun install
bun start                   # agent + dashboard together (Ctrl-C stops both) — the simple path
```

`bun start` (scripts/dev.ts) launches the control agent (http://127.0.0.1:6800) and the dashboard
(http://localhost:5273, `/api` proxied to `:6790`). Prefer separate processes? The granular commands
still work:

```bash
bun run agent               # control agent only  → http://127.0.0.1:6800
bun dev                     # dashboard only      → http://localhost:5273
```

The dashboard reads data from a bunqueue server. Start it from **Control ▸ Server** (the agent runs
it) or point the dashboard at an existing server via Settings / `VITE_BUNQUEUE_URL`.

## Gate — all three must be green before considering a change done

```bash
bun run build     # tsc --noEmit + vite build
bun run check     # biome lint + format (production-grade config)
bun test          # unit + agent lifecycle tests
```

CI runs this exact gate on every push and PR (`.github/workflows/ci.yml`).

### Biome config

`biome.json` is a **production-grade, root config** (`"root": true`, schema pinned to the installed
CLI). It **must** be root: this is a standalone repository with no parent Biome config, and with
`"root": false` Biome silently falls back to *default* rules on every file (thousands of spurious
errors — that is a broken gate, not real findings). The config enables `recommended` plus a curated
strict set (const/import-type/self-closing/optional-chain/template/no-double-equals/…) as **errors**,
with a few aspirational rules (`useExhaustiveDependencies`, `noUnusedFunctionParameters`, perf/spread)
as **warnings** so they surface without breaking the gate. `agent/` and `scripts/` are excluded
(they are Bun-runtime infra, not part of the app bundle). Keep new `src/` code passing the strict
rules; do not silence a rule to dodge a real fix.

## CI/CD

GitHub Actions under `.github/workflows/` (Bun pinned to the same version as local/Docker):

- **ci.yml** — on push to `main` + every PR: `bun run check`, `bun run build`, `bun test`; uploads
  the `dist/` artifact. This is the merge gate.
- **pages.yml** — on push to `main`: builds with `VITE_BASE` = the Pages sub-path, adds a
  `404.html` SPA fallback, deploys to GitHub Pages. It best-effort auto-enables Pages
  (`configure-pages enablement: true`); if the first run fails with `Get Pages site failed`, enable
  Settings ▸ Pages ▸ Source → GitHub Actions once (GITHUB_TOKEN can't create the site itself).
- **docker.yml** — on push to `main` + tags `v*`: builds the multi-arch image and pushes to
  `ghcr.io/egeominotti/bunqueue-dashboard` (`edge` on main, semver + `latest` on tags).
- **release.yml** — on EVERY push to `main` and on manual tags `v*`: re-runs the gate, zips
  `dist/`, cross-compiles **standalone executables for 5 platforms** (linux x64/arm64, macOS
  x64/arm64, windows x64 — `scripts/serve.ts` via `bun build --compile`: embedded SPA + `/api`
  proxy + control agent in one binary), and publishes a GitHub Release with generated notes.
  Auto-versioning bumps from the latest `v*` tag with decimal rollover (patch 0–9, then minor:
  `v0.1.9 → v0.2.0`). Auto-created tags use `GITHUB_TOKEN`, so they don't re-trigger docker.yml —
  semver/`latest` images still come from manually pushed `v*` tags (`edge` tracks every main push).

**The lockfile (`bun.lock`) is committed on purpose** — every workflow installs with
`bun install --frozen-lockfile`. Do not re-add it to `.gitignore`.

Deploy note: `vite.config.ts` reads `base` from `VITE_BASE` (default `/`), and `main.tsx` passes
`basename={import.meta.env.BASE_URL}` so the SPA works both at root (dev / Docker) and under the
Pages sub-path.

## Control agent security

The agent can spawn processes, so `agent/server.ts` enforces: **loopback bind (127.0.0.1)**, **CORS
locked to an allowlist** (ACAO never `*`), **403 on any disallowed `Origin`** (blocks drive-by CSRF),
and an **optional `AGENT_TOKEN`** bearer gate on state-changing requests. It is *not* the
"unauthenticated RCE by design" it once was — do not describe it that way. Configure via
`AGENT_ALLOWED_ORIGINS` / `AGENT_TOKEN`. Full threat model in `agent/server.ts`; verified limits in
`docs/known-issues.md`.

## Verified API-shape gotchas (learned from live testing — keep `bq.ts` honest)

- `GET /webhooks`, `/workers`, `/storage`, `/ping` wrap payload in **`{ ok, data: {...} }`**.
- `GET /queues/:q/dlq`, `/dlq/stats`, `/crons`, `/queues/:q/counts` are **flat** (`{ ok, ... }`, no `data`).
- DLQ entries are **`{ job, enteredAt, reason, error, attempts[] }`** — the job is nested, there is no top-level `id`/`name`.
- Jobs have **no `name`** field, **no embedded `result`** (fetch separately via `GET /jobs/:id/result`), and use
  **`startedAt` / `completedAt`** (not `processedOn` / `finishedOn`). `timeline[]` IS persisted (despite an
  in-source comment saying otherwise), capped at 20 entries.
- `PUT /queues/:q/rate-limit` takes **`{ limit }`**; concurrency takes `{ concurrency }` (or `{ limit }`).
- `bq.ts`'s `call()` throws on HTTP-200-with-`{ok:false}` too (many mutating endpoints use this for logical
  failure) — except `health()`, which passes `strict:false` because `/health`'s `ok` is a health flag, not a
  success flag. Follow that pattern for any endpoint where `ok` isn't "did this request succeed".
- Which job actions apply to which job state is centralized in `src/lib/jobActions.ts::actionGates` — use it,
  don't re-derive.
- Full endpoint map, request bodies, and the job-action state table live in `docs/api-mapping.md`. Verified,
  honest list of current dashboard bugs/limitations lives in `docs/known-issues.md` — check it before assuming
  something is a fresh bug.
