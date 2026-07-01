# Components, stores & shared lib

Reference for everything under `src/components/` and the non-API modules
under `src/lib/` — the pieces every page is built from. See
[architecture.md](architecture.md) for how these fit together and
[pages.md](pages.md) for what each page does with them.

## Layout shell (`src/components/layout/`)

- **`AppLayout.tsx`** — the only layout in the app. `flex h-screen` row:
  `Sidebar` + a column of `Topbar` and a scrollable `<main>` holding
  `<Outlet/>`. Every route in `App.tsx` renders inside this one shell.
- **`Sidebar.tsx`** — the `NAV` constant (a `NavGroup[]`) is the single source
  of truth for what's navigable; a route with no entry here (and no entry in
  `App.tsx`) is unreachable (see `Alerts.tsx` in
  [pages.md](pages.md#not-part-of-the-router)). Renders four sections
  (Queues / Monitoring / Control / Management) plus a floating Overview link.
  Below the nav: `ConnectionBadge` (a tiny dot + host, polls `api.health()`
  every `refreshMs` — note this is the **classic** client, independent of
  whatever `bq` calls the current page is making), `ThemeToggle` (flips
  `themeStore`), and `SidebarFooter`.
- **`SidebarFooter.tsx`** — identity card at the very bottom (bq logo badge +
  current host from `connectionStore` + a settings shortcut).
- **`Topbar.tsx`** — a sticky header showing a breadcrumb-style title
  (`TITLES` record keyed by pathname, falls back to `"bunqueue"`) and a
  settings-link avatar. See [known-issues.md](known-issues.md) for the routes
  its title map doesn't cover.

## UI kit (`src/components/ui/`)

Small, dependency-free primitives. No component library — everything here is
hand-rolled Tailwind + inline SVG.

| File | Exports | Notes |
| --- | --- | --- |
| `Card.tsx` | `Card`, `CardHeader`, `SectionTitle` | `Card` is a bordered/padded box (`padded={false}` to manage your own padding, e.g. for tables). `CardHeader` puts a title + optional icon + optional right-aligned action on one row. |
| `StatCard.tsx` | `StatCard`, `StatTone` | Label/value/optional-hint block; `tone` maps to a text colour (`default`/`green`/`red`/`blue`/`amber`/`accent`); `compact` shrinks padding/font for dense grids. |
| `StatusBadge.tsx` | `StatusBadge`, `StatusDot` | `StatusBadge` is the pill used everywhere a job/queue state is shown — its `STYLES` map (`waiting`/`active`/`completed`/`failed`/`delayed`/`prioritized`/`paused`/`waiting-children`/`stalled`) is the canonical colour-per-state mapping; reuse it (`<StatusBadge status={x}/>`) rather than re-deriving colours. `StatusDot` is the smaller "Live"/"Paused"/"Healthy" indicator used in page headers. |
| `Button.tsx` | `Button`, `IconButton` | `Button` variants: `default`/`ghost`/`accent`/`danger`/`warning`/`success`; sizes `sm`/`md`. `IconButton` is a square 32px button for row actions (defaults to `ghost`). Neither manages a loading spinner — callers pass `disabled={busy}` themselves. |
| `CopyButton.tsx` | `CopyButton` | Copies `value` via `navigator.clipboard.writeText`, flashes a check icon for 1.5s. Fails silently if the Clipboard API is unavailable (insecure context / permissions) — no error surfaced, by design (a copy button isn't worth an error banner). Added for `JobInspector`'s copyable job/custom IDs; reusable anywhere an ID needs copying. |
| `form.tsx` | `Label`, `Field`, `Input`, `Select`, `Toggle`, `SegmentedControl` | `Field` = `Label` + child, the standard label/control pairing used in every form on the site. `Input`/`Select` share one Tailwind class string (`controlClass`) so they always look identical. `Toggle` is a bespoke switch (not a native checkbox — `role="switch"`). `SegmentedControl<T>` is the pill-group filter (e.g. status tabs on `JobsPro`/`LogsPro`) — generic over the option type so callers get type-checked `value`/`onChange`. |
| `feedback.tsx` | `Spinner`, `LoadingState`, `EmptyState`, `ErrorState` | The three states every polled page cycles through: `LoadingState` (first load, no data yet), `ErrorState` (first load failed — shows `error.message` + an optional retry button), `EmptyState` (loaded successfully, nothing to show — icon + title + hint + optional action). Convention: check `loading && !data` before `error && !data` before rendering content, so a slow-but-eventually-successful load doesn't flash an error. |
| `Pagination.tsx` | `Pagination` | The shared pager under **every** list table. Two modes: pass `total` (known count — from server endpoints that return it, or a fully-loaded client list) to get "X–Y of Z" and a disabled Next on the last page; pass `hasNext` instead (unknown total — `GET /queues/:q/jobs/list` returns none) to drive Next off "did this page come back full". `page` is 0-based; it self-hides when a single page of known data fits. Callers keep a `const [page,setPage]=useState(0)` and either refetch with `offset=page*PAGE_SIZE` (server pagination) or `slice` the in-memory list (client pagination). Reset page to 0 when a filter/queue changes. |
| `PageHeader.tsx` | `PageHeader` | Every page's top block: `title` + optional `live` dot (green `StatusDot`) + `description` + right-aligned `actions` + optional `back` control. |
| `AreaChart.tsx` | `AreaChart`, `ChartSeries` | Pure-SVG multi-series line/area chart, no charting library. Renders a **rolling window** — `x` maps linearly over `points.length`, it does not know about real timestamps, so all series passed to one chart must share the same sampling cadence (see `useThroughputSeries`). Only consumer today is `MetricsPro`'s throughput chart. See [known-issues.md](known-issues.md) for its `NaN`/`Infinity` sensitivity. |
| `icons.tsx` | `Icon*` (24 icons) | Inline SVG, one export per icon, all built on a shared `<Icon>` wrapper (`stroke="currentColor"`, `1.75` width) so they inherit text colour and size uniformly via `className`. No icon package dependency. |

## Stores (`src/components/dashboard/stores/`, Zustand + `persist`)

All four stores use `zustand/middleware`'s `persist` to `localStorage`, so
settings survive a refresh. `test/setup.ts` shims `localStorage` so these
import cleanly under `bun test`.

- **`connectionStore.ts`** — `{ baseUrl, token, refreshMs }`. `baseUrl`
  defaults to `/api` (the Vite dev proxy target, see `vite.config.ts`) or
  `VITE_BUNQUEUE_URL` if set at build time. Exposes two **non-reactive**
  accessors, `getBaseUrl()`/`getAuthHeaders()`, used by `lib/api.ts` and
  `lib/bq.ts` outside of React (so a plain async function can read the
  current connection without being a hook). Both API clients re-read these on
  every call — changing the connection in Settings takes effect on the very
  next request, no reload needed.
- **`themeStore.ts`** — `{ theme: 'dark'|'light' }`. `applyTheme()` sets
  `document.documentElement.dataset.theme` (which Tailwind's `light:` variant
  keys off, see architecture.md) and the native `color-scheme` CSS property.
  `initTheme()` is called once from `main.tsx` **before** the first render so
  there's no flash-of-wrong-theme; `onRehydrateStorage` re-applies it after
  the persisted value loads.
- **`alertsStore.ts`** — `{ channels, rules }`, local-only. See
  [known-issues.md](known-issues.md) for the fact that its page isn't routed.
- **`s3Store.ts`** — S3 connection-settings draft for `S3BackupPro`, local
  only, never sent to the server (see [pages.md](pages.md)).

## Shared `lib/` (non-API)

- **`format.ts`** — every number/time/byte formatter used across the app
  (`formatNumber`, `formatPercent`, `formatDateTime`, `formatRelativeTime`,
  `formatDuration`, `formatUptime`, `formatBytes`, `errorRate`, `jobDuration`).
  Pure functions, fully unit-tested in `test/format.test.ts`. Always reach for
  one of these instead of formatting inline — consistency (`.` thousands
  separators, `it-IT`-style datetimes) depends on it.
- **`cn.ts`** — a 4-line className joiner (`cn(...parts)` → filters falsy,
  joins with spaces). Not `clsx`/`tailwind-merge`; no dedup or conflict
  resolution, just concatenation. Fine because Tailwind classes here are
  written statically, not dynamically composed in ways that would conflict.
- **`jobActions.ts`** — `actionGates(state)`, the single source of truth for
  "which job actions does the server currently accept". Shared by
  `JobInspector` (single-job actions) and `JobsPro` (per-row + bulk actions)
  so the two pages can never drift on what's legal — see
  [api-mapping.md](api-mapping.md#job-action-gating) for the full state table.
- **`usePolledData.ts`** / **`useActivityStream.ts`** / **`useThroughputSeries.ts`**
  — the three data-fetching hooks; see [architecture.md](architecture.md#data-flow).
  Notes worth knowing when writing a page:
  - `usePolledData(fetcher, deps, { intervalMs })` — the optional third arg
    overrides the global refresh for that hook. Use a large value (e.g.
    `{ intervalMs: 30000 }`) for a rarely-changing queue-name **dropdown** so it
    doesn't re-poll on the fast activity cadence. The hook is **self-scheduling**
    (one fetch in flight at a time), **pauses while the tab is hidden**, and
    **sequence-guards** stale resolutions — so it's safe to include `page` in
    `deps` and refetch on page change without racing.
  - `useThroughputSeries()` returns `{ push, complete, fail, depth }` rolling
    windows (one 1s poller feeds all four) plus a `depthTrend(depth)` helper that
    returns the backlog slope (`draining` / `accumulating` / `steady`) — used by
    MetricsPro's Queue Depth chart.
- **`sse.ts`** — the fetch-based SSE frame reader; see architecture.md.
