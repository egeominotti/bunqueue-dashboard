---
title: Database
---

# Database

> Route `/database` · source `src/pages/control/Database.tsx`

![Database](../screenshots/database.png)

An enterprise-grade, **read-only SQLite inspector** for bunqueue's on-disk store. It browses tables, reads schema/indexes/DDL, filters and sorts rows, opens full untruncated values in a detail drawer, exports to CSV/JSON, and runs hand-typed read-only SQL — all over a `readonly` connection served by the **local control agent** (`:6800`), never the bunqueue HTTP API. The `read-only` badge in the header is literal: writes are rejected by the SQLite engine itself and by a statement allowlist, so nothing on this page can mutate the store.

## What it shows

### Store metadata (top stat cards)

Rendered only once `bq.db.info()` returns (hidden while the DB is missing). Values come from SQLite `PRAGMA`s on the agent side.

| Field | Meaning |
| --- | --- |
| **SQLite** | Engine version string (`info.sqliteVersion`, e.g. `3.51.0`). |
| **On disk** | Human-readable total size = `fileSize + walSize` (main DB file + write-ahead log), formatted with `formatBytes`. |
| **Journal** | Journal mode uppercased (`info.journalMode`, typically `WAL`). |
| **Tables** | User-table count (`info.tables`), `formatNumber`-formatted. |
| **Indexes** | Index count (`info.indexes`). |

### Table list (left column)

A card headed `Tables (N)` listing every user table (SQLite internal `sqlite_%` tables are excluded server-side, ordered by name). Each row shows the table **name** (monospace, truncated if long) and its **live row count** on the right (`formatNumber(t.rows)`). The selected table is highlighted. If there are no tables the list shows `No tables.`

### Data grid (Data tab)

For the selected table, a sortable, paginated grid (50 rows/page).

| Element | Meaning |
| --- | --- |
| Column header | The column name; sortable columns are buttons. |
| **PK** badge | Shown next to primary-key columns (from the table schema). |
| type label | The declared SQLite type, lowercased, beside the column name. |
| Sort arrow | `▲` ascending / `▼` descending on the active sort column. |
| Cell value | Monospace; `NULL` rendered italic/faint. Numeric columns are right-aligned (detected by declared type `INT/REAL/NUM/DEC/DOUB/FLOA` or by all-numeric values). |
| `…` chip | An amber marker on a cell whose value was truncated server-side — click the row to see it in full. |
| Row hover | Rows are clickable (open the detail drawer). |

Below the grid, a `Pagination` control (page size 50, labelled `rows`) and, when any cell was truncated, the note that cells over 2000 chars and BLOBs are abbreviated in both grid and CSV.

### Schema tab

Three sections for the selected table:

- **Columns table** — `Column | Type | Constraints | Default`. Constraints render `PK` and/or `NOT NULL` badges; missing defaults show `—`.
- **Indexes (N)** card — each index by name with a `UNIQUE` badge where applicable and its `(columns…)`. Empty state: `No indexes on this table.`
- **DDL** card — the original `CREATE TABLE` SQL with a copy button. Only shown if `schema.sql` is present.

### Row detail drawer

Opens on row click as a right-hand slide-over titled `<table> · row detail`. Lists every column as a definition list: value pretty-printed (JSON strings expanded, multi-line/long values in a scroll box), `NULL` italic, a copy button per non-null value. Cells that were truncated in the grid are **lazy-fetched in full by rowid** via `bq.db.cell()` and show `(loading full value…)` until they arrive. Close with the X, the backdrop, or `Escape`.

### Query panel & results

A `Query` card at the bottom with a SQL textarea (seeded with `SELECT name FROM sqlite_master WHERE type = 'table'`). Results render as: a summary line (`N rows · M ms`, with `≥` prefix and `showing first …` when the result was row-capped) plus the same results grid, or `Query returned no rows.`

## What you can do

| Action | Effect | Confirm? |
| --- | --- | --- |
| Click a table (left list) | Selects it, switches to the **Data** tab, resets page/sort/filter/drawer. | No |
| Toggle **Data / Schema** tabs | Switches between the row grid and the schema view. | No |
| Click a column header | Cycles sort on that column: asc → desc → off. Resets to page 0. | No |
| **Filter bar** (column · operator · value) | Filters rows by one column with `contains`, `=` (`eq`) or `≠` (`ne`). Press Enter or **Filter**; **Clear** removes it. Resets to page 0. | No |
| Paginate | Move through 50-row pages. | No |
| Click a row | Opens the detail drawer with full untruncated values. | No |
| **Query** button (table header) | Seeds the SQL editor with `SELECT * FROM "<table>" LIMIT 100`, focuses and scrolls to it. | No |
| **Export page (N)** | Downloads the current 50-row page as `<table>-page<N>.csv`. Disabled when no rows. | No |
| **Export table (N)** | Streams the whole (filtered/sorted) table in 500-row batches into one `<table>.csv`, capped at 200,000 rows. Shows `Exporting…` and a result message. Disabled while busy or when empty. | No |
| SQL **Run** / ⌘/Ctrl+Enter | Executes the query (read-only). | No |
| SQL **Explain** | Runs `EXPLAIN QUERY PLAN <sql>`; result not saved to history. | No |
| Query **History** chips | Last 10 successful queries (localStorage `bq-dash-db-history`); click to reload one, **Clear** to empty. | No |
| Result **CSV** / **JSON** | Downloads the query result as `query-results.csv` / `query-results.json`. | No |
| Copy buttons | Copy a DDL, or a cell/field value, to the clipboard. | No |

::: info No destructive actions
This page has **no `window.confirm()` gates** — because it has no destructive actions. Every operation is a read or a client-side download. Even arbitrary SQL is blocked from writing (see below).
:::

**Filter bar validation:** the **Filter** button is disabled until the value is non-empty; applying an empty value clears the filter instead. The effective column defaults to the first column when none is chosen.

## States & gating

- **No database yet** — when `bq.db.tables()` returns HTTP **404** (the expected pre-first-start state), the whole page collapses to an `EmptyState` titled *No database yet* with the agent's message as hint. Start the bunqueue server once from **Control ▸ Server** to create the file. `bq.db.info()` polling is suppressed while missing.
- **Read failure (non-404)** — any other tables error shows an `OfflineBanner` (`Could not read the database — <message>`) with a **Retry**.
- **Loading** — while tables are loading with none yet, `Reading database…`. Row/schema loads show `Reading <table>…` / `Reading schema of <table>…`. During a background row refresh the grid dims (50% opacity, non-interactive) rather than flashing empty.
- **Empty table / no matches** — `Empty table` (`"<table>" has no rows.`) or, with a filter, `No matching rows`.
- **Could not read table** — an `EmptyState` with the row-read error when rows fail and no prior data exists.
- **Export buttons** — *Export page* disabled with 0 rows; *Export table* disabled while exporting or when `total === 0`.
- **Query buttons** — **Run** and **Explain** disabled while a query is running or the editor is empty; the button reads `Running…` in flight.
- **Stale-view guard** — every row page is tagged with its full view identity (table/page/sort/filter); a round-trip that no longer matches the current view is discarded so stale data never renders under a new selection. An out-of-range page (rows deleted underneath) snaps back to the last valid page instead of showing a false empty.

::: tip Not a job-action page
There is no `jobActions.ts` state→action gating here — that applies to Jobs/DLQ pages. Gating on this page is purely the read-only-connection and statement-allowlist enforcement described below.
:::

## Behind the scenes

All calls use the **`bq` client**, but the `bq.db.*` methods target the **control agent** (`:6800`, `/db/*`), not the bunqueue HTTP API. Reads are protected by the agent's Origin allowlist (not the optional `AGENT_TOKEN`, which gates only state changes — and the browser sends no token here).

| Purpose | Client call | Endpoint | Poll |
| --- | --- | --- | --- |
| Store metadata | `bq.db.info()` | `GET /db/info` | 15 s |
| Table list + row counts | `bq.db.tables()` | `GET /db/tables` | 10 s |
| Table schema/indexes/DDL | `bq.db.schema(t)` | `GET /db/tables/<t>/schema` | 30 s |
| Row page | `bq.db.rows(t, limit, offset, orderBy, dir, filter)` | `GET /db/tables/<t>?limit&offset[&orderBy&dir][&fcol&fop&fval]` | 6 s |
| Full cell value | `bq.db.cell(t, rowid, col)` | `GET /db/tables/<t>/cell?rowid&column` | on drawer open |
| Arbitrary query | `bq.db.query(sql)` | `POST /db/query` body `{ sql }` | on Run |

Server-side enforcement (`agent/db.ts`):

- **Read-only connection** + a positive **statement allowlist**: a query must lead with `SELECT / WITH / EXPLAIN / VALUES / PRAGMA` (regex `READ_ONLY_LEAD`), otherwise it's rejected with *"Only read-only … queries are allowed here."* ATTACH/DETACH/CREATE-TEMP and writes are refused by the engine and the allowlist.
- **Row cap `MAX_ROWS = 500`** — query and export batches are bounded; results over the cap are flagged `truncated` (the summary shows `≥`).
- **Cell truncation `MAX_CELL = 2000`** — strings longer than 2000 chars and BLOBs are abbreviated server-side (`truncatedCells[][]`); the drawer refetches the full value (up to `MAX_FULL_CELL = 1_000_000`).
- **Query timeout `QUERY_TIMEOUT_MS = 5000`** — arbitrary queries run off-thread in a disposable Worker and abort at 5 s under the normal path.
- Row pages carry `rowids[]` (null for `WITHOUT ROWID` tables), which keys the full-cell fetch.

Response-shape note: `bq.db.*` responses are the agent's own `{ ok, … }` shapes (documented inline in `bq.ts` around `db:`), distinct from the bunqueue API `{ ok, data }` / flat conventions in `docs/api-mapping.md`.

## Gotchas

::: warning Compiled-binary query timeout is inactive
Per `docs/known-issues.md`, in the **standalone compiled binaries** (`release.yml` / `scripts/serve.ts` via `bun build --compile`), `/db/query` has **no wall-clock timeout**: `bun build --compile` doesn't embed the Worker module, so `queryWithTimeout` degrades to a synchronous run. A deliberately pathological scan can pin the agent's thread until it finishes (still read-only, statement-allowlisted, and row-capped at 500 — just not interruptible). Under `bun start` / `bun run agent` the 5 s Worker timeout is active.
:::

- **Read-only means read-only.** Even valid `SELECT`s can't change data; anything else is rejected before touching the DB. This is a viewer, not a console.
- **Query results are capped at 500 rows.** Big result sets show `≥ 500 rows` and only the first 500; narrow the query or use table export for full data.
- **Table export is capped at 200,000 rows** and accumulates in the browser tab before download — a huge table stops at the cap with an *export cap reached* message.
- **BLOBs and >2000-char cells are abbreviated** in the grid and in CSV exports; open the row drawer to see/copy the full value.
- **`WITHOUT ROWID` tables have no rowid**, so full-cell refetch in the drawer isn't available for their truncated cells (the grid's truncated value stays).
- **Query history lives in localStorage** (`bq-dash-db-history`, max 10) — it's per-browser, not shared, and silently no-ops if storage is unavailable.
- Metadata, tables, schema and rows poll on independent cadences (15/10/30/6 s), so counts and sizes can lag a few seconds behind live writes on a busy server.
