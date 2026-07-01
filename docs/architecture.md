# Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                        Browser (SPA, :5273)                        │
│                                                                    │
│  main.tsx → <App/> (React Router)                                  │
│    └─ AppLayout ─ Sidebar + Topbar + <Outlet/>                     │
│         └─ pages/*  and  pages/control/*                           │
│                                                                    │
│  Data layer                                                        │
│    usePolledData(fetcher) ── interval ──► lib/bq.ts / lib/api.ts   │
│    useActivityStream()     ── SSE ───────► lib/sse.ts              │
│    useThroughputSeries()   ── 1s tick ───► bq.overview()            │
│    stores/: theme · connection · alerts · s3 (Zustand + persist)   │
└───────────┬──────────────────────────────┬────────────────────────┘
            │ HTTP /api (proxy → :6790)     │ /control (→ :6800)
            ▼                               ▼
   ┌─────────────────┐            ┌───────────────────────┐
   │ bunqueue server │            │ control agent (Bun)   │
   │  HTTP :6790     │◄──spawn────│  ProcessManager       │
   │  SSE /events    │   /health  │  binds 127.0.0.1:6800 │
   └─────────────────┘            └───────────────────────┘
```

## Components

- **Router & layout** — `App.tsx` declares every route (see
  [pages.md](pages.md) for the full, verified table — several routes'
  page-family assignment is not what the path name would suggest) under one
  `AppLayout` (`Sidebar` + `Topbar` + `<Outlet/>`). See
  [components.md](components.md) for the layout shell in detail.
- **Pages** — two families, distinguished by which API client they use, not
  by any visual marker:
  - `src/pages/*` — first-generation **classic** view pages. Use `lib/api.ts`.
  - `src/pages/control/*` — the **Pro**, full-control pages. Use `lib/bq.ts`.
    `pages/control/job/` and `pages/control/queue/` hold page-specific
    subcomponents too small to be their own page (e.g. `JobTimeline`,
    `JobBackoff`, `QueueActions`, `ConfigForms`).
  - The two families are not cleanly partitioned by route path — some Pro
    pages render at the "plain" path with the classic page pushed to
    `-classic` (`/jobs`, `/dlq`, `/metrics`, `/s3`); others have **no** Pro
    equivalent at all (`/queues`, `/workers`, `/usage`, `/settings`). See
    [pages.md](pages.md#route-table-from-srcapptsx) for the authoritative
    table — don't infer family from the URL.
  - One page mixes clients: `LogsPro` calls `bq.queues()` for the queue
    filter dropdown but `useActivityStream` (shared with the classic `Logs`
    page) builds its SSE URL via `api.eventsUrl()`. Not a bug — the SSE
    endpoint is identical either way — but worth knowing if you're grepping
    for "does this page use `bq` or `api`".
- **UI kit & stores** — see [components.md](components.md) for the full
  reference (`Card`, `StatCard`, `StatusBadge`, `Button`, `form.tsx`,
  `feedback.tsx`, `PageHeader`, `AreaChart`, `CopyButton`, inline SVG `icons`,
  and the four Zustand stores).

## Data flow

- **Polling.** `usePolledData(fetcher, deps)` runs the fetcher immediately and
  every `connectionStore.refreshMs` ms, keeping the last good value while
  refreshing (no flicker) and never calling `setState` after unmount. It has
  no per-request sequence guard — see [known-issues.md](known-issues.md) for
  the resulting (self-healing, non-corrupting) race on rapid filter changes.
- **Live activity.** `useActivityStream(queue?)` streams SSE from `/events`
  (or `/events/queues/:q`) via a fetch-based reader (`lib/sse.ts`) that
  supports a bearer token — unlike `EventSource`. It keeps a bounded ring
  buffer of recent events (`MAX_EVENTS = 250`), cumulative counters, and a
  rolling 5s throughput. Powers `OverviewPro`'s Recent Activity and both
  `LogsPro`/`Logs`. See known-issues.md for two verified gaps in its
  `connected` state and reconnect behaviour.
- **Throughput sampling.** `useThroughputSeries(windowSize=60)` is
  independent of both of the above — it ticks on its own 1-second
  `setInterval`, calling `bq.overview()` each time and appending
  `throughput.{pushPerSec,completePerSec,failPerSec}` into a rolling window
  for `MetricsPro`'s `AreaChart`. This means the chart's cadence is fixed at
  1s regardless of `connectionStore.refreshMs`.
- **Writes.** Page actions call `bq.*`/`api.*` (POST/PUT/DELETE) and then
  `refetch()`. Destructive actions (Cancel, Drain, Obliterate, Purge, Restart,
  Stop, remove-webhook) are gated behind `window.confirm` — there is no
  bespoke confirmation dialog component, by consistent convention across the
  whole app.
- **Job action gating.** Anywhere a job's Promote/Retry/Discard/Cancel/Requeue
  action is offered (`JobInspector`, `JobsPro`), the button set is computed by
  the single shared `lib/jobActions.ts::actionGates(state)` from the job's
  *current* state, mirroring exactly what the server's location-based
  handlers will accept (e.g. Cancel only for a queue-resident job). This
  avoids offering an action that would silently fail or throw. See
  [api-mapping.md](api-mapping.md#job-action-gating) for the full table.

## The API layer

Two clients, on purpose (see the additive rule in the project `CLAUDE.md`):

- **`lib/api.ts`** — the original client, used only by classic pages.
  Throws only on non-2xx HTTP status; does **not** inspect the response body
  for a logical `ok:false` (several bunqueue endpoints return HTTP 200 even
  on failure — see [api-mapping.md](api-mapping.md)). A few of its response
  types don't match the server's real shape (`storage()`, `DlqEntry`,
  `DlqStats`) — see [known-issues.md](known-issues.md).
- **`lib/bq.ts`** — the complete, shape-verified client behind every
  `pages/control/*` page and the control agent. Its `call()` helper throws on
  non-2xx **and** on a parsed `{ ok: false }` body, with one deliberate
  carve-out: `health()` passes `strict:false` because `GET /health`'s `ok`
  field means "server healthy" (can legitimately be `false` on disk-full with
  HTTP 200), not "request succeeded" — see api-mapping.md for why that
  distinction matters and which other endpoints are strict.
- Types for `bq` live in `lib/bqTypes.ts` (verified against a live server —
  see api-mapping.md); types for `api` live in `lib/types.ts`.
- **New work always uses `bq`.** Do not "fix" `api.ts` in place — add a
  corrected page using `bq` instead (the additive rule).

## The control agent

A tiny local Bun process (`agent/`) that supervises a bunqueue server child
process, because a browser can't start/stop an OS process and bunqueue's HTTP
API has no process-lifecycle endpoint. See [agent.md](agent.md) for the full
reference (endpoints, `ServerConfig`/`runningConfig` split, `dbStats()`).
**Read the security note in [known-issues.md](known-issues.md) before ever
exposing its port beyond your own loopback** — it has no authentication.

## Theming

Tailwind CSS v4 with CSS-variable tokens (`--bg`, `--surface`, `--line`, `--fg`,
`--muted`, `--accent`, …) mapped into Tailwind via `@theme inline`, so utilities
like `bg-surface` / `text-muted` / `border-line` flip instantly when
`data-theme` changes. Dark is the default; `light:` is a custom variant. Inter +
JetBrains Mono (variable) via Fontsource; numbers use tabular figures (`.tnum`).
`themeStore.initTheme()` applies the persisted theme before the first render
(no flash-of-wrong-theme); see the Stores section in
[components.md](components.md).
