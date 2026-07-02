---
title: Server Control
---

# Server Control

> Route `/server` · source `src/pages/control/ServerControl.tsx`

![Server Control](../screenshots/server.png)

Server Control supervises the bunqueue server **process** itself — its lifecycle (start / stop / restart), its launch configuration, its on-disk SQLite footprint, and a live tail of its logs. It is the one page that talks to the local **control agent** rather than to bunqueue's HTTP API, because a browser cannot start or kill an OS process on its own.

::: info Two backends, one page
Everything on this page — status, lifecycle, config, storage, logs — comes from the **control agent** at `http://localhost:6800` (`bq.agentBase`, override with `VITE_BUNQUEUE_AGENT_URL`). The only exception is the live **Memory** and **Connections** vitals, which come from the *bunqueue server's own* `GET /health` and are polled only while the process is running.
:::

## What it shows

The page is built from four regions, top to bottom: the **Status console** (the focal point), a two-column grid with the **Configuration** card on the left and **Storage** + **Process logs** stacked on the right, and a collapsible **"How server control works"** explainer at the bottom.

### Status console (`StatusConsole`)

A "mission-control" readout of the process. The top strip shows a colored status dot and label; the instrument cluster below is a 7-cell grid of vitals.

| Field | Meaning |
| --- | --- |
| State label | `Running` (green), `Starting` / `Stopping` (amber), or `Stopped` (red), from `status.status`. While an action is in flight it reads e.g. `starting…`. A pulsing "ping" ring appears only when running **and** healthy. |
| `bunqueue v…` | Server version, from `status.version` (shown when present). |
| `crashed · exit N` | Red pill shown when the process is not running and exited with a non-zero `exitCode`. |
| Sub-line | When running: `healthy` (or `waiting for health…`) · `pid` · `up <uptime>`. The uptime ticks live every second (client-side, from `startedAt`). When stopped: a hint to start it or point the dashboard at an external server. |
| **Memory** | `<rss> MB rss` from the server's `/health` `memory.rss`. The tooltip adds `heap heapUsed / heapTotal MB`. Shows `—` while stopped. |
| **Connections** | `<tcp> tcp · <ws> ws · <sse> sse` live connection counts from `/health` `connections`. Shows `—` while stopped. |
| **API endpoint** | `http://localhost:<httpPort>`. While running it is a clickable link to `/health` (opens a new tab) with a copy button; while stopped it is plain gray text. |
| **Ports** | `<httpPort> http · <tcpPort> tcp` from the running config (falls back to the saved config). |
| **Started** | Absolute start timestamp (`formatDateTime`), only while running. |
| **Control agent** | The agent host:port (protocol stripped), e.g. `localhost:6800`. |
| **Launch command** | The exact command the process was launched with (from `runningConfig.command`, falling back to `config.command`). |

::: tip Running vs. saved config
The console prefers `status.runningConfig` — what the live process was actually launched with — and only falls back to the editable `status.config` when nothing is running. That is why the console can show different ports/command than the Configuration card while you have unsaved or un-restarted edits.
:::

### Configuration card (`ConfigCard` + `EnvVarsEditor`)

The launch config the agent will use on the next start/restart. Seeded once from `status.config`, then freely editable.

| Field | Meaning |
| --- | --- |
| **Command** | The exact command the agent runs to launch bunqueue (default `bunqueue start`). It always receives `HTTP_PORT`, `TCP_PORT` and `BUNQUEUE_DATA_PATH` in its environment. |
| **HTTP port** | Dashboard API + SSE port. Number input, 1–65535. |
| **TCP port** | Binary-protocol port. Number input, 1–65535; must differ from HTTP. |
| **Data path** | SQLite database file path, relative to the **agent's** working directory. |
| **Environment variables** | Key/value editor (`EnvVarsEditor`) for `extraEnv`, injected on top of the always-set ports + data path. |

The header hint changes with state: while running it reads "Ports and data path apply on the next restart — edit freely, then restart"; while stopped, "Edit and save; the config is used the next time the server starts."

The env editor shows an explainer when empty (reminding you the agent already injects `HTTP_PORT` / `TCP_PORT` / `BUNQUEUE_DATA_PATH`), an `=`-separated KEY/value row per variable with an `✕` remove button, and one-click preset chips for common bunqueue knobs: `AUTH_TOKENS`, `LOG_LEVEL`, `S3_BACKUP_ENABLED`, `S3_BUCKET`, `METRICS_ENABLED` (a chip disappears once that key is in use). Duplicate keys trigger a "last value wins" warning and are de-duplicated when serialized.

### Storage panel (`StoragePanel`)

The on-disk footprint of the SQLite store, rendered as one proportional bar rather than separate cards. Rendered only when `status.db` is present.

| Field | Meaning |
| --- | --- |
| Header | `<totalSize> on disk` (human bytes) — or `not created yet` when the file does not exist. |
| Path | The `db.path`, monospace and truncated, with a copy button. |
| **Database** (accent bar) | Main `.db` file size (`db.size`). |
| **WAL** (amber bar) | Write-ahead-log sidecar (`db.walSize`). |
| **SHM** (gray bar) | Shared-memory index sidecar (`db.shmSize`). |
| `written …` | Relative time of the last write (`db.mtimeMs`), shown at the right when present. |

Each bar segment is widthed as its share of `totalSize`; a zero-byte segment is omitted. When the DB does not exist yet, a dashed-border placeholder explains it will appear after the first start.

### Process logs (`ProcessLogs`)

A live tail of the managed process's `stdout` / `stderr` plus agent `sys` messages. `stderr` renders red, `sys` accent-blue, `stdout` muted.

- **Stream filter** — a segmented control: `all` / `stdout` / `stderr` / `sys`.
- **Filter box** — case-insensitive substring search over the line text.
- **Follow** toggle — auto-scrolls to the tail on new lines (on by default); turn it off to scroll up and read without being yanked back.
- **Times** toggle — prefixes each line with an `HH:MM:SS.mmm` timestamp.
- **Copy** — copies exactly what is shown (respecting filters and the Times toggle).
- **Download** — saves the shown text as `bunqueue-logs-<timestamp>.log` (disabled when nothing is shown).
- Footer — `<n> lines` (or `<shown> of <total> lines` when filtered) on the left; `following tail` / `paused` on the right.

## What you can do

| Action | Effect | Confirm? |
| --- | --- | --- |
| **Start** | `bq.control.start()` — agent spawns the process with the saved config. | No |
| **Stop** | `bq.control.stop()` — agent terminates the process. | Yes — "Stop the bunqueue server?" |
| **Restart** | `bq.control.restart()` — stop then start. | Yes — "Restart the bunqueue server?" |
| **Save config** | `bq.control.setConfig(value)` — persists the edited config on the agent; used on the next start. Flashes "Saved" for 2s. | No |
| **Save & restart** | `setConfig()` then `restart()` — persist *and* apply immediately. Only shown while running. | Yes — "Save configuration and restart the server to apply it?" |
| **Add/remove env var, presets** | Edits `extraEnv` in the form (not persisted until you Save). | No |
| **Filter / Follow / Times / Copy / Download logs** | Local, client-side view controls over the log tail — no server call. | No |

::: warning Ports are validated before any write
Both **Save config** and **Save & restart** run the same guard first: each port must be an integer 1–65535, and HTTP must differ from TCP. On failure the write is aborted and the error message appears inline in red next to the buttons — nothing is sent to the agent.
:::

A `Restart to apply changes` amber hint appears next to the buttons when the edited config differs from `runningConfig` (command, either port, data path, or the env map) — i.e. the running process is out of date relative to what you have saved.

## States & gating

- **Loading** — the Configuration card renders `Loading…` until `status.config` arrives; vitals show `—` until `/health` responds.
- **Agent unreachable, no cached data** (`error && !data`) — the whole page is replaced by an **OfflineBanner** plus a card explaining the agent is unreachable at `bq.agentBase`, with the exact commands to start it (`bun start` / `bun run agent`). It reconnects automatically once the agent is up — no reload needed.
- **Agent went stale** (`error && data`, i.e. it answered before but the latest poll failed) — an amber banner appears ("Control agent unreachable — showing last known state. Lifecycle actions are disabled until it responds again"), the console switches to a "last known" read (no live uptime, no false "healthy"), and **all lifecycle buttons are disabled**.
- **Action error** — any failed lifecycle/config call surfaces its message in a red banner at the top (`actionError`) or inline (config `err`).

Button enablement in the console:

| Button | Enabled when |
| --- | --- |
| Start | **not** running, not transitioning, not stale |
| Stop | running, not transitioning, not stale |
| Restart | not transitioning, not stale |

Here `transitioning` means the status is `starting`/`stopping` **or** an action (`busy`) is in flight. While busy, config inputs and both config buttons are disabled too, and **Save & restart** is only rendered while the server is running.

## Behind the scenes

All lifecycle/config/log calls use the **`bq.control.*`** client, which hits the **control agent** (`bq.agentBase`, default `http://localhost:6800`):

- `GET /control/status` → `ServerStatus` — the page's primary poll (`usePolledData(() => bq.control.status())`).
- `POST /control/start` · `POST /control/stop` · `POST /control/restart` — lifecycle actions; each returns the fresh `ServerStatus`, and the page also calls `refetch()` after.
- `PUT /control/config` (`bq.control.setConfig`) — persist config. `GET /control/config` exists on the client (`getConfig`) but this page reads config from the status payload, not this endpoint.
- `GET /control/logs` → `{ lines: ServerLogLine[] }` — polled independently by `ProcessLogs` (`usePolledLogs`).

The live vitals use the ordinary **`bq.health()`** client against the bunqueue server (not the agent), and only while `status === 'running'` — when stopped, the fetcher resolves to `null` so a down server isn't polled.

**Polling cadence.** Both `usePolledData` hooks (status and logs) use the global refresh interval from the connection store — **3000 ms by default**, adjustable in Settings (floored at 500 ms). The poll is a recursive `setTimeout` (at most one request in flight) and only re-renders when the serialized payload actually changes. There is **no SSE** on this page. The uptime clock is a separate client-side 1s ticker and does not hit the network.

::: info `/health` `ok` is a health flag, not a success flag
Per `docs/api-mapping.md`, `GET /health` is flat and its `ok` means "is the server healthy" (a disk-full server returns `ok:false` with HTTP 200), so `bq.health()` is called with `strict:false` and does not throw on `ok:false`. `memory` values are in **MB**; `connections` are live `tcp` / `ws` / `sse` counts.
:::

## Gotchas

- **Config never applies in place.** Command, ports and data path only take effect on the **next start/restart** — the running process keeps the config it launched with. Use **Save & restart** (or Restart after Save) to apply.
- **The default command needs a global `bunqueue` binary.** If you don't have one, point Command at a local entry, e.g. `bun run /path/to/bunqueue/src/main.ts`.
- **Data path is relative to the *agent's* working directory**, and SQLite creates the *file* but not its *parent folder*. A start that fails with `SQLITE_CANTOPEN` usually means the directory doesn't exist yet — create it or choose a path whose folder already exists.
- **Logs are a ring buffer.** The agent keeps the most recent **~800 lines** (`MAX_LOGS`, trimmed with a 256-line slack margin), so older output scrolls off; use **Download** to keep a copy.
- **Stale-agent freeze is deliberate.** Per `docs/known-issues.md`, ServerControl now shows the amber "agent unreachable" banner and disables lifecycle actions on any poll failure that follows a successful one — instead of the old behavior of asserting "Running / healthy" with a live-ticking uptime for a dead agent.
- **`GET /control/config` is unused here.** The card seeds itself from the status payload (`status.config`), so the standalone config endpoint isn't fetched; don't expect this page to reflect an out-of-band config change until the next status poll.
