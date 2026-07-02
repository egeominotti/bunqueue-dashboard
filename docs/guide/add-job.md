---
title: Add Job
---

# Add Job

> Route `/add-job` · source `src/pages/control/AddJob.tsx`

![Add Job](../screenshots/add-job.png)

The manual job-enqueue form. It pushes one job — or up to ten thousand copies — into any
queue (existing or brand new) with every enqueue option bunqueue supports, without writing a
producer script. Everything on the page is a controlled form: nothing is submitted until you
press **Add job**.

## What it shows

The page is a single `<form>` (max width `3xl`) made of two cards plus a submit row. There are
no stat cards, tables, or live counters here — it is a pure input surface.

### Job card

| Field | Meaning |
| --- | --- |
| **Queue** | Free-text `Input` wired to a `<datalist id="queue-options">`. The dropdown suggestions come from the live queue list (`bq.queues()`), but the field is not a closed select — typing a name that does not exist is allowed and creates a new queue on submit. Placeholder: `queue name (existing or new)`. |
| **Data (JSON)** | A 7-row monospace `<textarea>` (spellcheck off) pre-filled with `{ "hello": "world" }`. This is the raw job payload; it is `JSON.parse`d client-side before sending. A parse error renders in red directly under the editor (`Invalid JSON: <message>`) and blocks submission. |

### Options card

A 2-column (3 on `md`) grid of numeric/text inputs, then a row of four toggles. Every option
is optional — the placeholder shows the server default that applies when you leave the box empty.

| Field | Input | Placeholder / default | Meaning |
| --- | --- | --- | --- |
| **Priority** | number | `0` | Job priority. Lower dequeues first (bunqueue convention). |
| **Delay (ms)** | number, `min=0` | `0` | Delay before the job becomes eligible; a non-zero value enqueues it as `delayed`. |
| **Max attempts** | number, `min=1` | `3` | Total attempts before the job is exhausted / sent to DLQ. |
| **Backoff (ms)** | number, `min=0` | `1000` | Retry backoff between attempts. |
| **Timeout (ms)** | number, `min=0` | `—` | Per-attempt processing timeout. Blank = no timeout. |
| **Custom job ID** | text | `idempotency key` | Sets the job's `jobId`. Acts as an idempotency key — reusing an ID collapses duplicates server-side. |

Below the grid, four toggles map directly to boolean body fields (each labelled with its raw
field name in monospace):

| Toggle | Field | Effect |
| --- | --- | --- |
| **removeOnComplete** | `removeOnComplete` | Delete the job record once it completes. |
| **removeOnFail** | `removeOnFail` | Delete the job record once it fails. |
| **durable** | `durable` | Persist the job durably. |
| **lifo** | `lifo` | Push to the front (last-in-first-out) instead of the tail. |

### Submit row

| Element | Meaning |
| --- | --- |
| **Count** | Narrow (`w-28`) number input, `min=1`, defaults to `1`. How many copies of the body to enqueue. `1` uses the single-add endpoint; `>1` uses the bulk endpoint. |
| **Add job** button | Accent (pink) submit. Shows `Adding…` and is disabled while a request is in flight. |
| **Result line** | After submit, a message appears next to the button: green on success (`Created job <id>` for a single add, `Created N job(s)` for bulk), red on failure (validation message or the thrown API error). |

::: info Toggles are off by default
`removeOnComplete`, `removeOnFail`, `durable`, and `lifo` all start unchecked, and an unchecked
toggle is omitted from the request entirely (sent as `undefined`), not sent as `false`.
:::

## What you can do

| Action | Effect | Confirm? |
| --- | --- | --- |
| Enqueue a single job | With Count = 1, calls `bq.addJob`; result line shows `Created job <id>`. | No |
| Bulk-enqueue N jobs | With Count > 1, calls `bq.addJobsBulk` with N copies of the same body; result shows the count of **distinct** created IDs. | No |
| Create a new queue | Type a queue name that isn't in the datalist — the server creates it on first enqueue. | No |
| Set any enqueue option | Fill any Options field; blanks are dropped so the server default applies. | No |

There are **no `window.confirm()` gates on this page** — pressing **Add job** submits immediately.
The only friction is client-side validation (below).

### Client-side validation (in submit order)

1. **Queue required** — empty/whitespace queue → red `Choose a queue`, nothing sent.
2. **Valid JSON** — `dataText` must `JSON.parse`; otherwise `Invalid JSON: <message>` under the
   editor, nothing sent.
3. **Count is a positive integer** — non-integer or `< 1` → `Count must be an integer of at least 1`.
4. **Count ceiling** — `> 10000` → `Count must be 10000 or fewer`.

Numeric option fields go through a helper: a blank or non-finite value becomes `undefined`
(omitted), so empty boxes never send `0` or `NaN`.

## States & gating

This is not a job-action page, so there is no `src/lib/jobActions.ts` state→action gating here.

- **Loading** — none for the form itself; it renders immediately with defaults. The Queue
  datalist populates once `bq.queues()` returns (and quietly re-fills every 30 s). If that call
  fails or is slow, the field still works as free text — you just get no autocomplete suggestions.
- **Busy** — while a submit is in flight, the button reads `Adding…` and is `disabled`, preventing
  a double-submit. All other inputs stay editable.
- **Error** — validation errors and API failures surface in the inline result line (or under the
  JSON editor). A thrown API error's message is shown verbatim in red; the form is not cleared, so
  you can fix and retry.
- **Empty / offline** — if the bunqueue server is unreachable, submitting produces a red result
  line with the fetch/error message; the datalist simply stays empty.

## Behind the scenes

Everything uses the **`bq`** client (never `api.ts`).

| Purpose | Call | Endpoint / method | Notes |
| --- | --- | --- | --- |
| Queue autocomplete | `bq.queues()` | `GET /dashboard/queues?limit=500&offset=0` | Polled via `usePolledData` every **30 s** (`intervalMs: 30000`) — a slow poll because the queue list rarely changes. |
| Single add (Count = 1) | `bq.addJob(queue, body)` | `POST /queues/:q/jobs` | Returns `{ ok, id }`; result shows `Created job <id>`. |
| Bulk add (Count > 1) | `bq.addJobsBulk(queue, jobs)` | `POST /queues/:q/jobs/bulk` | Sends `{ jobs: [...] }` (N copies of the same body); returns `{ ok, ids }`. |

The request body (`AddJobBody`) is assembled with only the fields the form exposes: `data`,
`priority`, `delay`, `maxAttempts`, `backoff`, `timeout`, `jobId`, `removeOnComplete`,
`removeOnFail`, `durable`, `lifo`. Undefined optionals are stripped by JSON serialization.

::: warning `bq.call` throws on `{ ok: false }`
The `bq` client treats an HTTP-200 response carrying `{ ok: false }` as a thrown error (strict
mode), so a logical failure from `POST /queues/:q/jobs` still lands in the red result line rather
than being silently swallowed.
:::

## Gotchas

::: warning Bulk + Custom job ID collapses to one job
When Count > 1 **and** a Custom job ID is set, every element in the bulk request carries the
*same* `jobId`, so the server dedupes them into a single job. The server's `ids` array still
returns one entry per element (see `docs/known-issues.md`), so the UI counts the **distinct** IDs
(`new Set(r.ids).size`) and honestly reports e.g. `Created 1 job` instead of the requested count.
:::

- **Not every `AddJobBody` field is exposed.** The type also supports `ttl` and `uniqueKey`, but
  this form has no inputs for them — you can only set them via the raw API. Only the 11 fields
  listed above are sendable from this page.
- **No name field.** bunqueue jobs have no `name`; the identity you can control is the `jobId`
  (Custom job ID). Everything else about the job is the JSON `data` payload.
- **Fire-and-forget.** The page reports the created ID(s) but does not follow the job — use
  [Job Inspector](/guide/) (`/job?id=<uuid>`) or the Jobs page to watch it run.
- **Bulk sends identical copies.** There is no per-element variation; all N jobs share one body.
  For distinct payloads you need multiple submits or a real producer script.
- **New-queue side effect.** A typo in the Queue field silently creates a brand-new queue rather
  than erroring — double-check the name before a large bulk enqueue.
