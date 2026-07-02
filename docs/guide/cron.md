---
title: Cron Jobs
---

# Cron Jobs

> Route `/cron` · source `src/pages/control/CronManager.tsx`

![Cron Jobs](../screenshots/cron.png)

The **Cron Manager** creates, lists, and deletes repeatable schedules on the bunqueue
server. A schedule enqueues a job into a target queue either on a **cron expression**
(e.g. `0 9 * * *`) or on a fixed **interval in milliseconds**. Everything here talks
directly to bunqueue's HTTP API — the local control agent is not involved.

## What it shows

The page header reads **"Cron Manager"** with the subtitle _"Schedule and manage
repeatable jobs."_ and a **live** indicator, because the list re-polls on an interval.

At the top is a **Create schedule** card (the form — see [What you can do](#what-you-can-do)).
Below it is a table of every registered schedule, paginated client-side at **15 rows per
page**. Each row is one cron entry (`CronFull`):

| Column | Meaning | Derived from |
| --- | --- | --- |
| **Name** | The schedule's unique identifier. | `c.name` |
| **Queue** | The queue jobs are pushed into when the schedule fires (monospace). | `c.queue` |
| **Schedule** | The trigger: the cron expression if set, otherwise `every <N>ms` for an interval schedule, otherwise `—` when neither is present (monospace). | `c.schedule ?? (c.repeatEvery ? \`every ${c.repeatEvery}ms\` : '—')` |
| **Next Run** | Absolute local date-time of the next scheduled execution, formatted via `formatDateTime`. | `c.nextRun` (epoch ms) |
| **Runs** | Total number of times this schedule has fired so far, right-aligned with tabular numerals and thousands separators. | `formatNumber(c.executions)` |
| _(trailing)_ | A trash **Delete cron** icon button per row. | — |

::: info
`CronFull` also carries `maxLimit` and `timezone`, but this page does **not** render
them — they are fetched (part of the `/crons` shape) and ignored by the table.
:::

## What you can do

| Action | Effect | Confirm? |
| --- | --- | --- |
| **Create schedule** | Submits the form → `bq.createCron(body)` → refetches the list. | No |
| **Delete a schedule** | Trash icon on a row → `bq.deleteCron(name)` → refetches. | Yes — `confirm("Delete cron \"<name>\"?")` |
| **Retry (offline)** | The offline banner's retry re-runs the poll. | No |
| **Paginate** | Move between 15-row pages (client-side; no request). | No |

### The Create schedule form

Inputs and validation, in order:

- **Name** (text, placeholder `daily-report`) — **required** (trimmed non-empty).
- **Queue** (text, placeholder `reports`) — **required** (trimmed non-empty).
- **Mode toggle** — a `SegmentedControl` with two options, **`cron`** and **`every`**.
  The two are mutually exclusive: the toggle shows exactly one field, and only that
  value is sent in the body.
  - **`cron`** → **Cron expression** field (placeholder `0 9 * * *`) — required; sent
    as `schedule` (trimmed).
  - **`every`** → **Every (ms)** numeric field (placeholder `30000`) — must parse to a
    **whole integer greater than 0**; sent as `repeatEvery`.
- **Data (JSON)** (monospace text, default `{}`) — the payload attached to every job the
  schedule enqueues. Must be **valid JSON**; empty/whitespace is treated as `{}`.

The submit button reads **Create** and shows **Creating…** while busy. On success the
Name, Cron expression, and Every fields are cleared and a green **"Cron created ✓"**
badge appears for ~3 seconds. On failure the error message is shown inline in red.

::: tip Double-submit is guarded
`submit()` bails immediately if already `busy`, and the button is `disabled` while
submitting — so a fast double-click cannot create the schedule twice.
:::

Validation errors surfaced inline (before any request is sent):

- `Name and queue are required`
- `Cron expression required` (in `cron` mode)
- `Interval must be a whole number of milliseconds greater than 0` (in `every` mode)
- `Data is not valid JSON`

## States & gating

- **Loading** — while the first poll is in flight (`loading && !data && !error`), a
  `LoadingState` with label **"Loading crons…"** replaces the table. The Create form is
  always mounted, so you can start typing before data arrives.
- **Empty** — when the server returns zero schedules, an `EmptyState` shows the cron icon,
  title **"No scheduled jobs"**, and hint **"Create one above."**
- **Error / offline** — if the poll fails, an `OfflineBanner` with a **Retry** button
  renders at the top of the page. The last-known list stays visible.
- **Action error** — a failed **delete** shows its message in a red banner above the
  Create card. This is deliberate: a confirmed delete that silently no-ops would read as
  success, so the failure reason is surfaced instead. Create-form errors show inline in
  the form, not in this banner.
- **Pagination clamp** — `safePage` is clamped to the last valid page, so deleting the
  last row on the final page won't strand you on an out-of-range page.

There is no per-state job-action gating here (this is not a job-action page, so
`src/lib/jobActions.ts` does not apply). The only conditional control is the mode toggle,
which swaps the cron-expression and interval fields.

## Behind the scenes

All calls use the **`bq`** client (not the legacy `api`):

- **List** — `GET /crons` via `bq.crons()`, driven by `usePolledData`. The poll cadence
  is the global refresh interval from the connection store, **default `3000` ms** (floored
  at 500 ms). Polls run back-to-back with a recursive timeout (at most one request in
  flight), which is why **Next Run** and **Runs** update on their own.
- **Create** — `POST /crons` via `bq.createCron(body)` with body
  `{ name, queue, data, schedule? | repeatEvery? }`. Note the page only ever sends one of
  `schedule` / `repeatEvery`; the `CreateCronBody` type also allows `priority`, `timezone`,
  `skipIfNoWorker`, `preventOverlap`, but this form does not expose them.
- **Delete** — `DELETE /crons/:name` via `bq.deleteCron(name)` (the name is URL-encoded).

::: warning Response-shape gotcha
`GET /crons` is **flat** — `{ ok, crons[] }`, with no `data` wrapper (unlike
`/webhooks` / `/workers` / `/storage`, which nest under `data`). The page reads
`data?.crons ?? []` accordingly. Also, because `bq`'s `call()` throws on an HTTP-200 body
with `{ ok: false }`, a logically-failed create/delete surfaces as a thrown error rather
than a silent no-op.
:::

## Gotchas

- **No edit.** Schedules can only be created or deleted — there is no update/pause. To
  change a schedule, delete it and create a new one.
- **No client-side cron validation.** The cron expression is only checked for
  non-emptiness; malformed expressions are the server's job to reject, and that error
  arrives back through the inline form error.
- **Ignored fields.** `maxLimit` and `timezone` come back from `/crons` but aren't shown,
  and the create form can't set `timezone`/`priority`/overlap flags even though the API
  accepts them.
- **Duplicate routes are intentional.** Per `docs/known-issues.md`, this same component
  also serves `/cron-manager`, and the older **list-and-delete-only** classic page lives
  at `/cron-classic` (`src/pages/Cron.tsx`). The sidebar's "Cron Jobs" entry opens this
  Pro page at `/cron`. This additive duplication is by design, not a bug.
- **Interval unit is milliseconds.** `every 300000ms` is 5 minutes — a common trap is to
  enter seconds. The field enforces a positive whole integer but not a sane magnitude.
