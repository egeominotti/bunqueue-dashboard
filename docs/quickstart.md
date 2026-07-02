---
title: Quickstart
description: Get the bunqueue dashboard running in one command, then point it at a bunqueue server or let the control agent start one for you.
---

# Quickstart

Get the dashboard running in under a minute, then connect it to a bunqueue
server. Prefer to look before you install? Open the
[live demo](https://egeominotti.github.io/bunqueue-dashboard/), the full
dashboard running on sample data with no server needed.

## Prerequisites

- [Bun](https://bun.sh) 1.3 or newer.
- A bunqueue server to drive, or let the control agent start one for you (step 3).

## 1. Install

```bash
git clone https://github.com/egeominotti/bunqueue-dashboard.git
cd bunqueue-dashboard
bun install
```

## 2. Run

```bash
bun start
```

One command boots the control agent and the dashboard together, and stops both
on `Ctrl-C`:

| Service | URL | Role |
| --- | --- | --- |
| Dashboard | `http://localhost:5273` | the UI (`/api` is proxied to `:6790`) |
| Control agent | `http://127.0.0.1:6800` | starts / stops / restarts the server process |

Open **`http://localhost:5273`**.

## 3. Connect a server

Two ways, pick either:

- **Let the agent start one.** Open **Control ▸ Server**, set the launch command,
  and press **Start**. The dashboard manages the process and tails its logs live.
  See [Server Control](/guide/server).
- **Point at an existing server.** Open **[Settings](/guide/settings)** and set the
  server URL (and a bearer token if it runs with `AUTH_TOKENS`), or bake it in at
  build time with `VITE_BUNQUEUE_URL`.

## Next steps

- Take the [illustrated tour of every screen](/user-guide).
- [Add your first job](/guide/add-job), then watch it in the
  [Jobs Explorer](/guide/jobs).
- Ship it: [Docker, Kubernetes, PM2, or a hosting platform](/deploy/).
- Press **Cmd / Ctrl-K** anywhere for the command palette.

::: tip Already have a server?
The dashboard never imports or modifies bunqueue, it only talks to its HTTP API,
so you can point it at any bunqueue server you already run.
:::
