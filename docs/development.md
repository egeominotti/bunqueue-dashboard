---
title: Development
description: "Set up, run, build, and test the bunqueue dashboard locally: the one-command dev launcher, the quality gate, and the project layout."
---

# Development

New here? Start with the [Quickstart](quickstart.md) for a guided first run, then
use the [deployment overview](deploy/index.md#how-the-dashboard-finds-your-server)
to choose how the dashboard connects to bunqueue. Control-agent environment
variables are documented under [Control agent configuration](agent.md#configuration).
This page is the day-to-day workflow: run, gate, and how to add a page additively.

## Run

```bash
bun install
bun start                   # agent + dashboard together (Ctrl-C stops both)
```

`bun start` (`scripts/dev.ts`) is the one-command path. Prefer separate
processes? The granular commands still work:

```bash
bun run agent               # control agent (start/stop/restart) → 127.0.0.1:6800
bun dev                     # dashboard → http://localhost:5273
```

Point it at a server via **Settings** (or `VITE_BUNQUEUE_URL`). In dev, `/api/*`
is proxied to `http://localhost:6790`.

## Quality gate

```bash
bun run quality
```

This is the exact blocking gate run by the
[CI workflow](https://github.com/egeominotti/bunqueue-dashboard/actions/workflows/ci.yml)
on every push and pull request. Release, Pages, and Docker run the same command
before publishing. It executes, in order:

- `bun run check`: Biome lint and formatting (`bun run check:fix` applies safe fixes).
- `bun run build`: strict typechecks for `src/`, `agent/`, and `scripts/`, then the
  production Vite build.
- `bun run size`: initial-load and total JavaScript bundle budgets.
- `bun run docs:build`: the VitePress production build, including dead-link checks.
- `bun run test:coverage`: the complete Bun test suite plus aggregate coverage floors.
- `bun run audit:high`: a blocking dependency audit for HIGH and CRITICAL advisories.

The audit has one ID-specific exception: `GHSA-qwww-vcr4-c8h2` affects React
Router's RSC mode. This project is a client-only `BrowserRouter` SPA and has no
RSC request handler or server actions, so that advisory is not applicable. The
exception does not suppress any other advisory; a new HIGH or CRITICAL finding
fails the gate. Remove it if the app adopts RSC, or when a compatible patched
React Router release becomes available.

Notes:
- `biome.json` is a **production-grade root config** (`"root": true`, schema pinned
  to the installed CLI). It *must* be root: this is a standalone repo with no parent
  Biome config, and with `"root": false` Biome silently falls back to default rules
  on every file (a broken gate, not real findings). It enables `recommended` plus a
  curated strict set as errors, with a few aspirational rules as warnings.
  `src/index.css` (Tailwind v4 at-rules), `agent/`, and `scripts/` are excluded from
  Biome. They are not skipped by typechecking: `tsconfig.json` covers `src/`, while
  `tsconfig.agent.json` covers both Bun runtime directories (except the generated
  `scripts/embedded.gen.ts`).
- `bunfig.toml` preloads `test/setup.ts` (a `localStorage` shim) so store imports
  work under `bun test`.

## Adding a page (additive)

1. Create `src/pages/control/MyPage.tsx` (a new file). Use `bq` for data, the
   `ui/*` kit for layout (see [components.md](components.md)), `usePolledData`
   for polling.
2. Wire it in `src/App.tsx` (a new `<Route>`).
3. Add a nav item in `src/components/layout/Sidebar.tsx`'s `NAV` array (reuse
   an existing icon or add one to `ui/icons`).
4. If the page shows a job/queue state, drive its state-dependent buttons off
   `lib/jobActions.ts::actionGates` rather than re-deriving which actions are
   dashboard-authorized, see
   [api-mapping.md](api-mapping.md#job-action-gating). Upstream endpoint
   acceptance alone is not authorization: the shared gates intentionally keep
   DLQ retry and completed-job requeue false.

**Both steps 2 and 3 are required**, a route with no nav entry (or vice
versa) is a dead end. `src/pages/Alerts.tsx` is exactly this: fully built, routed nowhere, findable only by reading the source (see
[pages.md](pages.md#not-part-of-the-router)). Don't leave a new page in that
state.

**Do not rewrite existing pages or the `api.ts` client.** Corrected behaviour goes
in a new page using `bq`. If you find a live bug while working nearby, check
[known-issues.md](known-issues.md) first, it may already be tracked, and add
it there if not, rather than silently patching something out of scope.

## Conventions

- Data: `usePolledData(() => bq.x())` returns `{ data, error, loading, refetching, refetch }`.
  Render `LoadingState` on first load, `ErrorState` on failure with data absent, otherwise the content (keep last data while refreshing).
- Actions: call `bq.*` then `refetch()`; guard destructive ops with
  `window.confirm`; surface failures inline.
- Formatting: use `lib/format` (`formatNumber` uses `.` thousands; times are
  relative; durations from `startedAt`/`completedAt`).
- Styling: Tailwind tokens (`bg-surface`, `text-muted`, `border-line`, `text-accent`), `.tnum` for numbers, mono for IDs.
- Keep files focused; prefer new small components over growing a page past ~300 lines.

## Tests

Use `bun test` for a fast local iteration and `bun run test:coverage` for the
same suite with the CI coverage floor. Tests live under `test/` and cover pure
logic, stores and clients, component regressions, SSE parsing, and control-agent
behaviour. Add focused regression coverage there for every bug fix or new
testable behaviour.
