---
title: Server Control
---

# Server Control

Server Control is where you start, stop, and restart the bunqueue server, set how it launches, and watch its logs live.

**Where:** open `/server` from the sidebar.

![Server Control](../screenshots/server.png)

## What you'll see

The page has four parts, top to bottom: a **Status console** at the top, a **Configuration** card, a **Storage** panel, and a live **Process logs** tail.

The status console is the focal point — a mission-control readout of the running process. A colored dot tells you the state at a glance: green for running, amber while starting or stopping, red when stopped. Below it sits a cluster of vitals:

| Element | What it tells you |
| --- | --- |
| **State** | `Running`, `Starting`, `Stopping`, or `Stopped`. A pulsing ring appears only when the server is running *and* healthy. |
| **Version** | The bunqueue version the running server reports. |
| **Health & uptime** | While running: `healthy` (or `waiting for health…`), the process id, and a live-ticking uptime. |
| **Memory** | Current memory use in MB. Hover for heap detail. Shows `—` while stopped. |
| **Connections** | Live TCP, WebSocket, and SSE connection counts. Shows `—` while stopped. |
| **API endpoint** | The server's address. While running it's a clickable link to its health page, with a copy button. |
| **Ports** | The HTTP and TCP ports in use. |
| **Started** | When the process started (shown only while running). |
| **Control agent** | The address of the local agent that manages the process. |
| **Launch command** | The exact command the process was started with. |

The **Configuration** card holds the settings the server will launch with next time you start or restart it:

| Element | What it tells you |
| --- | --- |
| **Command** | The command the agent runs to launch bunqueue (default `bunqueue start`). |
| **HTTP port** | The dashboard API and live-update port (1–65535). |
| **TCP port** | The binary-protocol port. Must differ from the HTTP port. |
| **Data path** | Where the SQLite database file lives. |
| **Environment variables** | A key/value editor for any extra settings you want to pass in. |

The **Storage** panel shows the SQLite database's footprint on disk as one proportional bar: the main **Database** file plus its **WAL** and **SHM** sidecars, with the total size, the file path (copyable), and when it was last written. Before the server has ever run, it shows a placeholder explaining the file appears after the first start.

**Process logs** is a live tail of the server's output. Error lines show in red, agent messages in blue, normal output in muted gray. A footer shows the line count and whether the view is following the tail or paused.

## What you can do

**Start the server.** Click **Start** and the agent launches bunqueue with your saved configuration.

**Stop the server.** Click **Stop** to shut it down.

::: warning
Stop asks you to confirm ("Stop the bunqueue server?") because it terminates the running process.
:::

**Restart the server.** Click **Restart** to stop and start it again — the fastest way to apply configuration changes. This also asks for confirmation.

**Edit and save the launch configuration:**

1. Change the command, ports, data path, or environment variables in the Configuration card.
2. Click **Save config** to store your changes for the next start (a "Saved" note flashes for a moment).
3. To apply them right away instead, click **Save & restart** — this saves *and* restarts in one step. It confirms first and only appears while the server is running.

**Manage environment variables.** Add a variable with a key and value, remove one with the `✕` button, or click a preset chip (like `LOG_LEVEL` or `AUTH_TOKENS`) to add a common setting fast. These stay in the form until you save.

**Work with the logs.** Filter by stream (`all` / `stdout` / `stderr` / `sys`), search the text, toggle **Follow** to auto-scroll (or turn it off to read back without being pulled to the bottom), toggle **Times** to show timestamps, **Copy** what's shown, or **Download** it as a `.log` file.

::: tip Ports are checked before anything is saved
Both **Save config** and **Save & restart** validate your ports first: each must be a whole number from 1 to 65535, and the HTTP port must differ from the TCP port. If a port is invalid, nothing is saved and an error appears in red next to the buttons.
:::

## Good to know

- **Configuration never applies in place.** Changes to the command, ports, or data path only take effect on the **next start or restart** — the running server keeps what it launched with. Use **Save & restart** to apply immediately. When your saved config is ahead of the running one, a "Restart to apply changes" hint appears next to the buttons.
- **The default command needs a global `bunqueue` binary.** If you don't have one installed, point **Command** at a local entry instead, for example `bun run /path/to/bunqueue/src/main.ts`.
- **The data path's folder must already exist.** The server creates the database *file* but not its parent *folder*. A start that fails with a "cannot open" error usually means the directory isn't there yet — create it, or pick a path whose folder already exists.
- **Logs don't keep forever.** Only the most recent ~800 lines are held, so older output scrolls off. Use **Download** to save a copy you want to keep.
- **When the agent can't be reached**, the page tells you plainly. If it was never reachable, you'll see how to start it. If it stops responding after working, an amber banner shows the last known state and the Start/Stop/Restart buttons are disabled until it answers again — this is intentional, so the page never claims a dead server is "healthy." It reconnects on its own once the agent is back; no reload needed. See [Known issues](/known-issues).
- **Memory and Connections need a running server.** Those vitals come from the live server, so they read `—` whenever it's stopped.

::: details Under the hood (for developers)
- Lifecycle, configuration, and logs all go through the local **control agent** (`bq.control.*`, default `http://localhost:6800`): `GET /control/status` is the primary poll, `POST /control/start|stop|restart` drive the process, `PUT /control/config` persists config, and `GET /control/logs` feeds the log tail.
- The live **Memory** and **Connections** vitals come from the bunqueue server's own `GET /health` (via `bq.health()`, called with `strict:false`) and are polled only while the process is running.
- Polling uses the global refresh interval from Settings — **3000 ms by default** (floored at 500 ms), at most one request in flight. There is no SSE on this page; the uptime clock is a separate client-side 1-second ticker.
:::
