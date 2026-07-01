# Known issues

Verified against the current source (not speculative) — each entry cites the
exact file so you can confirm or fix it. None of these are catastrophic; the
dashboard is fully usable. They're documented here because "professional docs"
means being honest about the rough edges, not hiding them.

## Recently fixed (kept here for history)

A performance + pagination pass resolved these — no longer present:

- **Per-poll fan-outs collapsed.** OverviewPro (was 8 req/poll), MetricsPro
  (was 22), DlqPro (was N+2) now issue 2–3 requests per poll via
  `GET /queues/summary`; JobsPro is single-queue server-paginated (was up to 25
  `jobs/list` per poll). `usePolledData` is now self-scheduling (at most one
  fetch in flight, no pile-ups) and **pauses while the tab is hidden**.
- **Every list is paginated** — see the `Pagination` component in
  [components.md](components.md). Server-paginated where the API supports it
  (queues, DLQ via offset/limit/total; jobs via offset/limit + `hasNext`),
  client-paginated for full-list endpoints (crons, webhooks, workers, activity).
- **`usePolledData` race fixed** with a generation guard (last-to-START wins).
- **MetricsPro/`Metrics` latency** now reads the real nested per-operation
  percentiles (`push`/`pull`/`ack` × p50/p95/p99) instead of always-0.
- **Uptime** no longer rendered ~1000× too large (ms→s) on OverviewPro/MetricsPro.
- **Topbar titles** now cover all Control routes (no more "bunqueue · bunqueue").
- **`bq.call()`** now throws on HTTP-200-with-`{ok:false}` (except `health()`),
  so failed cancel/purge/retry surface as errors instead of false success.
- **Responsive**: fluid root type (`clamp()`), a mobile nav drawer + hamburger,
  responsive padding. See [components.md](components.md).

A stability re-check resolved these — no longer present:

- **`StatusBadge` no longer crashes on a missing/undefined `status`.**
  `status.toLowerCase()` had no guard; two nav-reachable callers
  (`LogsPro.tsx`, `JobTimeline.tsx`) passed `e.status`/`e.state` with no
  fallback, unlike `JobsPro`/`JobInspector` which already defaulted to
  `'waiting'`. Fixed at the root (`StatusBadge.tsx`) so all six callers are
  covered: empty/undefined status now renders as "unknown" instead of
  throwing.
- **`AreaChart` no longer blanks on a `NaN`/`Infinity` point.** `finite()`
  sanitizes each value to `0` before it reaches the max computation or the
  SVG path builder, so one bad point degrades to a dip instead of corrupting
  every series' path data.

## Audit fix pass (this change-set)

A full-component adversarial audit fixed the following. Each was verified, then
fixed with the gate (build + biome + `bun test`) green; the agent + store fixes
ship with reproducing tests (`test/agent-server.test.ts`, `test/manager.test.ts`,
`test/sse.test.ts`, `test/s3store.test.ts`).

- **Control agent is no longer unauthenticated-RCE-by-design.** `agent/` now
  enforces an **Origin allowlist** and **locked CORS** (never `*` — ACAO is
  reflected only for allowed origins) and rejects any request carrying a
  disallowed `Origin` (403) before it reaches the `ProcessManager`. A malicious
  tab's cross-origin `PUT /control/config` → `POST /control/start` can no longer
  set + run a command. Non-browser callers (curl) still work. Set `AGENT_TOKEN`
  for an extra bearer-token gate on state-changing requests; configure allowed
  origins via `AGENT_ALLOWED_ORIGINS`. Handler logic is factored into
  `agent/server.ts` (unit-tested). See [agent.md](agent.md).
- **Agent stop/start race fixed.** A `stop()` awaiting an old process could
  orphan a process a concurrent `start()` brought up (manager reported
  "stopped" while a server was still running). `ProcessManager` now guards every
  `onExit`/`stop()` mutation by a monotonic process token.
- **`ConfigForms` cross-queue write fixed.** `StallForm`/`DlqConfigForm` now
  `useEffect(() => setC(config), [config])` and `QueueControl` renders them with
  `key={queue}`, so switching queue no longer saves queue A's stall/DLQ config
  onto queue B. Save now surfaces errors inline (was silent + unhandled rejection).
- **`useActivityStream` connection indicator fixed.** `connected` now flips true
  on *any* delivered frame (the handshake carries `data.connected` with no
  `event:` line), so an idle-but-live queue no longer shows "Connecting…" forever;
  and the stream now **auto-reconnects** (2s backoff) after a clean end / server
  restart instead of going silently dead.
- **`OverviewPro` banner reflects connection loss.** After the first successful
  poll, a later failure now shows an amber "Connection lost — showing last known
  data / Stale" banner instead of a permanent green "Online" over frozen numbers.
  Recent Activity rows now show the real `queue`/`jobId` (were all "unnamed").
- **`setRateLimit` now actually applies.** `api.setRateLimit` sent `{max,duration}`
  but the server reads `{limit}`, so the classic `QueueDetail` rate-limit control
  silently no-op'd while showing "Saved". It now sends `{limit}`; the dead
  "Duration (ms)" input was removed. `api.ts`'s `request()` now also throws on
  HTTP-200-`{ok:false}` (except `storage()`/`health()`), matching `bq.call()`.
- **S3 secret no longer persisted.** `s3Store` uses `partialize` to keep
  `accessKeyId`/`secretAccessKey` in memory only — they are no longer written to
  `localStorage` in plaintext.
- **`AddJob` bulk-with-custom-ID** now reports the real created count
  (`new Set(ids).size`) and caps/validates `Count` (≤10000).
- **`DlqControl`** no longer fetches unused `dlqStats` (whose failure blanked the
  whole page). **`DlqPro`** keeps the `Pagination` control mounted when a
  page-scoped reason/search filter matches nothing (was a navigation trap), and
  labels its page-scoped sort honestly on multi-page queues.
- **`QueueDetail` Recent Jobs** now shows real Name (`data.name`) and Duration
  (`startedAt`/`completedAt`) instead of "unknown"/"—".
- **`Workers`** surfaces a "showing first 100 of N" hint when the list is
  truncated. **`ServerControl`** validates ports (1–65535, HTTP≠TCP) before
  restart. **`Topbar`** guards `decodeURIComponent` (malformed URL no longer
  crashes the shell). **`useThroughputSeries`** has an in-flight guard (no
  overlapping polls). **`Webhooks`** enable/disable toggle has an accessible name.
- **App-wide `ErrorBoundary`.** `src/components/ErrorBoundary.tsx` wraps the
  whole shell, so a single render throw shows a recoverable fallback instead of
  blanking the entire app.

The items below are the ones **still** open (mostly confined to the off-nav
`*-classic` legacy pages, kept per the additive convention).

## Correctness — silent wrong data (off-nav legacy pages)

- **`lib/api.ts`'s `storage()` and the classic `Usage`/`S3Backup` pages
  disagree with the real `/storage` shape.** The server wraps the payload —
  `GET /storage` → `{ ok, data: { diskFull, error, since } }` (see
  [api-mapping.md](api-mapping.md)) — but `api.ts:76` types it as
  `{ ok, status: StorageStatus }` and `S3Backup.tsx`/`Usage.tsx` read
  `data?.status?.diskFull` / `data?.status?.path`. Neither field exists at
  that nesting, so both pages always render "Healthy" and a blank Path,
  **masking a real disk-full condition**. `lib/bq.ts`'s `storage()` has the
  correct `{ ok, data }` type and is used correctly by `S3BackupPro`'s "Test
  Connection" — the bug is confined to the classic `api.ts` path. Note
  `/storage` never returns a `path` field either way; that row is dead
  regardless of the wrapping fix.
- **`lib/types.ts`'s `DlqEntry` models a shape the server doesn't return.** The
  real DLQ entry is `{ job: Job, enteredAt, reason, error, attempts:
  AttemptRecord[] }` — nested. `api.ts`'s `DlqEntry` declares top-level
  `id`/`jobId`/`name`/`failedAt`, which don't exist on the real object (masked
  by its `[key: string]: unknown` index signature, so TypeScript doesn't catch
  it). `Dlq.tsx` (classic) renders `e.jobId ?? e.id` (→ blank), `e.name`
  (→ always "unknown"), and uses `e.id` as the React key (→ `undefined`,
  duplicate-key warnings). `DlqPro`/`DlqControl` use the corrected
  `DlqEntryFull` from `bqTypes.ts` and read `e.job.id` — they're fine.
- **The classic `Dlq.tsx` also crashes on a non-empty DLQ** — it renders
  `{e.attempts}` (an `AttemptRecord[]`) directly as a table cell → React
  "Objects are not valid as a React child". Confined to `/dlq-classic`
  (off-nav); the default `/dlq` (`DlqPro`) is unaffected.

## Performance (off-nav legacy pages)

- **`Jobs.tsx` (classic, `/jobs-classic`) polls the full queue list every 3s.**
  `usePolledData(() => api.queues(500), [])` (Jobs.tsx:32) fetches up to 500 full
  queue rows on the fast global cadence purely to feed the queue dropdown and the
  `slice(0, 25)` fan-out list — data that changes rarely. The primary route
  `/jobs` → `JobsPro` already throttles the equivalent to 30s
  (`{ intervalMs: 30000 }`), so the real user path is efficient. Left as-is per
  the additive rule (classic pages are reported, not edited in place); the fix, if
  ever wanted, is to add `{ intervalMs: 30000 }` to that call. An efficiency pass
  applied the same throttle to every *Pro* page (QueueControl, LogsPro, AddJob,
  JobsPro overview) and split the DLQ/Metrics duplicate `/dashboard` polls.

## UX gaps

- **`src/pages/Alerts.tsx` is fully built but unreachable.** See
  [pages.md](pages.md#not-part-of-the-router). If you're looking for an
  "Alerts" nav item and can't find one, this is why.

## Design limitations (not bugs — how bunqueue OSS works)

- **S3 backup cannot be configured from the dashboard.** Both `/s3` and
  `/s3-classic` are explicit about this: bunqueue reads `S3_BACKUP_ENABLED`,
  `S3_BUCKET`, etc. from the **server process's environment**. `S3BackupPro`'s
  form is a local-only (`localStorage`) convenience for assembling that env
  config to paste elsewhere — it has no effect on the running server, and
  "Backup Now" is permanently disabled.
- **Alerts have no backend.** `alertsStore` persists rules/channels to
  `localStorage` only; nothing evaluates them. bunqueue OSS has no alerting
  engine — wire the rules into your own monitoring, or use hosted bunqueue
  Cloud.
- **Multiple pages cover overlapping ground on purpose** (three DLQ pages, two
  cron pages, `-classic` duplicates) — this is the additive convention from
  `CLAUDE.md`, not accidental drift. See
  [pages.md](pages.md#sidebar--page-mapping).
