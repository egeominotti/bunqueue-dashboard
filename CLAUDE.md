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
dashboard/
├── agent/                     # Bun control agent (process lifecycle) — NOT linted/typechecked with src
│   ├── manager.ts             # ProcessManager: spawn/kill bunqueue, log ring buffer, dbStats()
│   └── index.ts               # HTTP server exposing /control/* (binds 127.0.0.1, NO auth — see docs/known-issues.md)
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
│   │       │                   # Diagnostics, S3BackupPro
│   │       ├── job/            # JobInspector subcomponents: JobTimeline, JobBackoff
│   │       └── queue/          # QueueControl subcomponents: QueueActions, ConfigForms
│   ├── App.tsx                # routes — see docs/pages.md for the verified route→page table
│   └── main.tsx                # entry (fonts, theme, router)
├── test/                      # bun test (format, sse, manager)
└── docs/                      # how it works — see docs/README.md; docs/known-issues.md tracks verified gaps
```

## Run

```bash
bun install
bun run agent/index.ts      # control agent → http://127.0.0.1:6800 (for start/stop/restart)
bun dev                     # dashboard → http://localhost:5273 (/api proxied to :6790)
```

The dashboard reads data from a bunqueue server (start it yourself, or from the
Server page via the agent).

## Gate — all three must be green before considering a change done

```bash
bun run build     # tsc --noEmit + vite build
bun run check     # biome lint + format
bun test          # unit + agent lifecycle tests
```

`biome.json` is a **nested** config (`"root": false`) so it does not conflict with
the repo-root biome — never make it a root config again.

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
  honest list of current dashboard bugs/limitations (including the control agent's lack of auth) lives in
  `docs/known-issues.md` — check it before assuming something is a fresh bug.
