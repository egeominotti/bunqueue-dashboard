# Development

New here? Start with [getting-started.md](getting-started.md) for a guided first
run, and [configuration.md](configuration.md) for the full env reference. This
page is the day-to-day workflow: run, gate, and how to add a page additively.

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

## Gate (keep all three green)

```bash
bun run build     # tsc --noEmit + vite build
bun run check     # biome (lint + format);  bun run check:fix to autofix
bun test          # format + sse + agent-lifecycle tests
```

This is the exact gate CI runs on every push and PR
([ci-cd.md](ci-cd.md)) — keep all three green before considering a change done.

Notes:
- `biome.json` is a **production-grade root config** (`"root": true`, schema pinned
  to the installed CLI). It *must* be root: this is a standalone repo with no parent
  Biome config, and with `"root": false` Biome silently falls back to default rules
  on every file (a broken gate, not real findings). It enables `recommended` plus a
  curated strict set as errors, with a few aspirational rules as warnings.
  `src/index.css` (Tailwind v4 at-rules), `agent/`, and `scripts/` are excluded from
  Biome; `agent/` and `scripts/` are Bun runtime code and are not in `tsconfig`.
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
   legal — see [api-mapping.md](api-mapping.md#job-action-gating).

**Both steps 2 and 3 are required** — a route with no nav entry (or vice
versa) is a dead end. `src/pages/Alerts.tsx` is exactly this: fully built,
routed nowhere, findable only by reading the source (see
[pages.md](pages.md#not-part-of-the-router)). Don't leave a new page in that
state.

**Do not rewrite existing pages or the `api.ts` client.** Corrected behaviour goes
in a new page using `bq`. If you find a live bug while working nearby, check
[known-issues.md](known-issues.md) first — it may already be tracked — and add
it there if not, rather than silently patching something out of scope.

## Conventions

- Data: `usePolledData(() => bq.x())` returns `{ data, error, loading, refetching, refetch }`.
  Render `LoadingState` on first load, `ErrorState` on failure with data absent,
  otherwise the content (keep last data while refreshing).
- Actions: call `bq.*` then `refetch()`; guard destructive ops with
  `window.confirm`; surface failures inline.
- Formatting: use `lib/format` (`formatNumber` uses `.` thousands; times are
  relative; durations from `startedAt`/`completedAt`).
- Styling: Tailwind tokens (`bg-surface`, `text-muted`, `border-line`,
  `text-accent`), `.tnum` for numbers, mono for IDs.
- Keep files focused; prefer new small components over growing a page past ~300 lines.

## Tests

`bun test` covers pure logic (`format`), SSE frame parsing (`sse`), and the real
`ProcessManager` lifecycle (`manager`, spawns `sleep`/`echo`). Add tests next to
these under `test/` for any new pure logic or agent behaviour.
